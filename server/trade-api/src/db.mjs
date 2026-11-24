// 数据库层：node:sqlite（Node 22 内置，零依赖）
// 设计要点：
//   1. 账号只存 username / username_lc / password_hash —— 没有设备标识、没有公钥、
//      没有 IP / UA / 指纹。sessions 只存随机 token 与过期时间。
//   2. 所有余额变更都必须同时写 ledger，禁止裸 UPDATE wallets
//   3. 金额一律用整数（最小单位），不用浮点

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db')

let db

export function open (dbPath = DB_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  db = new DatabaseSync(dbPath)
  // WAL：读写不互相阻塞；断电后可从 wal 恢复
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate()
  return db
}

export function get () {
  if (!db) throw new Error('db not opened')
  return db
}

// accounts 的 DDL 只写一份：新库直接建，老库靠它重建。
// 一行账号 = user_id + 用户名 + 口令哈希 + 创建时间，仅此而已。
// kind 是历史字段（曾有 'guest'），现在建号一律 'password'，保留只为兼容旧行的约束。
const accountsDdl = (name, ifNotExists = false) => `
  CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS' : ''} ${name} (
    user_id       TEXT PRIMARY KEY,
    display       TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'password' CHECK (kind IN ('guest','password')),
    username      TEXT,
    username_lc   TEXT,
    password_hash TEXT,
    created_at    INTEGER NOT NULL,
    banned        INTEGER NOT NULL DEFAULT 0,
    -- 密码账号必须同时有用户名和口令哈希，游客两者都为空
    CHECK (kind = 'guest' OR (username_lc IS NOT NULL AND password_hash IS NOT NULL))
  );`

function migrate () {
  // 迁移期必须关外键：accounts 要整表重建（SQLite 不能删列/改约束），
  // 而 wallets.user_id 引用它。重建完再 foreign_key_check 兜底。
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    migrateSchema()
    const bad = db.prepare('PRAGMA foreign_key_check').all()
    if (bad.length) throw new Error('迁移后外键校验失败：' + JSON.stringify(bad))
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

// 老库（只有 user_id/display/pubkey）→ 带用户名口令的账号表。
// 老库里的 pubkey 列直接丢弃：**账号只认口令，设备公钥不再收**。
function migrateAccountsLegacy () {
  const cols = db.prepare("SELECT name FROM pragma_table_info('accounts')").all().map((r) => r.name)
  if (!cols.length || cols.includes('kind')) return
  console.log('[migrate] accounts 表结构升级（丢弃 pubkey 列）')
  db.exec('PRAGMA legacy_alter_table = ON')
  db.exec('DROP TABLE IF EXISTS accounts_v2')
  db.exec(accountsDdl('accounts_v2'))
  db.exec(`INSERT INTO accounts_v2 (user_id, display, kind, created_at, banned)
           SELECT user_id, display, 'guest', created_at, banned FROM accounts;`)
  db.exec('DROP TABLE accounts')
  db.exec('ALTER TABLE accounts_v2 RENAME TO accounts')
  db.exec('PRAGMA legacy_alter_table = OFF')
}

// 清掉已经废弃的两张表：device_keys（设备公钥）、challenges（签名 nonce）。
// 留着它们等于「虽然不写，但历史数据还在」—— 用户明确要求设备相关数据一律不留。
function dropLegacyAuthTables () {
  const gone = []
  for (const t of ['device_keys', 'challenges']) {
    const has = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(t)
    if (!has) continue
    const n = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c
    db.exec(`DROP TABLE IF EXISTS ${t}`)
    gone.push(`${t}(-${n})`)
  }
  if (gone.length) console.log('[migrate] 已删除废弃表：' + gone.join(' '))
}

function migrateSchema () {
  migrateAccountsLegacy()
  dropLegacyAuthTables()
  db.exec(`
    ${accountsDdl('accounts', true)}
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username_lc) WHERE username_lc IS NOT NULL;

    -- 云存档：粒度 = (账号, 存档位)，与造化平台 (account, game, slot) 对齐（单游戏省掉 game 维度）
    -- rev 是记录版本，用于乐观锁；造化那边 version 恒为 1，后写覆盖，这里补上
    CREATE TABLE IF NOT EXISTS saves (
      user_id    TEXT NOT NULL,
      slot       TEXT NOT NULL,
      rev        INTEGER NOT NULL DEFAULT 1,
      payload    TEXT NOT NULL,
      bytes      INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, slot)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS wallets (
      user_id     TEXT PRIMARY KEY REFERENCES accounts(user_id),
      balance     INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0)
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      delta       INTEGER NOT NULL,
      reason      TEXT NOT NULL,
      ref         TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, id DESC);

    -- ========== 订单簿（同质商品：同 item_id 完全等价，可堆叠） ==========
    -- 为什么装备不能进这张表：affix.ts 明写「词条只属于物品实例，不属于 defId」，
    -- 同一把 10003 可以是锋锐+6% 也可以是坚韧+8%。属性不同即不可互换，
    -- 订单簿「按价格撮合、任意一件交割」的前提不成立。装备走下面的 listings。
    CREATE TABLE IF NOT EXISTS book_orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      side        TEXT NOT NULL CHECK (side IN ('buy','sell')),
      item_id     TEXT NOT NULL,
      price       INTEGER NOT NULL CHECK (price > 0),   -- 单价（最小货币单位）
      qty         INTEGER NOT NULL CHECK (qty > 0),
      filled      INTEGER NOT NULL DEFAULT 0,           -- 已成交数量，支持部分成交
      status      TEXT NOT NULL DEFAULT 'open',         -- open | filled | cancelled
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      CHECK (filled >= 0 AND filled <= qty)
    );
    CREATE INDEX IF NOT EXISTS idx_book_sell ON book_orders(item_id, side, price ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_book_buy ON book_orders(item_id, side, price DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_book_user ON book_orders(user_id, id DESC);

    -- ========== 寄售（唯一实例：装备） ==========
    CREATE TABLE IF NOT EXISTS listings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      item_id     TEXT NOT NULL,
      price       INTEGER NOT NULL CHECK (price > 0),
      snapshot    TEXT NOT NULL,          -- 实例全量属性（词条、耐久、强化等级…）JSON
      fingerprint TEXT NOT NULL,          -- sha256(snapshot) 前 32 hex
      status      TEXT NOT NULL DEFAULT 'open',   -- open | sold | cancelled
      buyer_id    TEXT,
      created_at  INTEGER NOT NULL,
      sold_at     INTEGER
    );
    -- 同一件装备（同一 fingerprint）同时只能有一个在售挂单 → 挡住「同一件挂十次」
    CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_open ON listings(fingerprint) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_listing_item ON listings(item_id, status, price, id);
    CREATE INDEX IF NOT EXISTS idx_listing_user ON listings(user_id, id DESC);

    -- ========== 成交（两个市场共用，审计与对账的唯一真相） ==========
    CREATE TABLE IF NOT EXISTS trades (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      market      TEXT NOT NULL CHECK (market IN ('book','listing')),
      item_id     TEXT NOT NULL,
      qty         INTEGER NOT NULL,
      price       INTEGER NOT NULL,       -- 单价（book 用 maker 价，listing 用挂单价）
      gross       INTEGER NOT NULL,       -- price * qty
      fee         INTEGER NOT NULL,       -- 从卖家所得里扣的 5%
      buyer_id    TEXT NOT NULL,
      seller_id   TEXT NOT NULL,
      buy_order   INTEGER,
      sell_order  INTEGER,
      listing_id  INTEGER,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trades_item ON trades(item_id, id DESC);

    -- ========== 交割队列 ==========
    -- 成交不能把物品直接塞进玩家背包（服务端看不到客户端存档），
    -- 所以做成「待领取」：客户端拉到 claim 后在本地入包，再上报已领（幂等）。
    CREATE TABLE IF NOT EXISTS claims (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      item_id     TEXT NOT NULL,
      qty         INTEGER NOT NULL,
      snapshot    TEXT,
      source      TEXT NOT NULL,          -- trade | listing_cancel
      trade_id    INTEGER,
      claimed     INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_claims_user ON claims(user_id, claimed, id);

    -- ========== 撮合（搜打撤 PVP） ==========
    -- 我们自己的服务器只当「导演」：决定谁建房、谁加入、什么时候开。
    -- 房间本身由玩家客户端在造化平台创建，我们从不碰房间的准入 token。
    --
    -- 一人同时只能有一张活票（queued/formed/ready/seated），用偏索引兜住，
    -- 而不是靠应用层查一次再插 —— 并发下那是检查-使用竞态。
    CREATE TABLE IF NOT EXISTS match_tickets (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      mode            TEXT NOT NULL,
      ruleset         TEXT NOT NULL,      -- 构建 hash / 规则版本：不同版本不进同一局
      state           TEXT NOT NULL,      -- queued | formed | ready | seated | left | done
      match_id        TEXT,
      role            TEXT,               -- host | guest；host 负责建房
      seed            INTEGER,            -- 整局共用的随机种子，由服务端下发
      requeues        INTEGER NOT NULL DEFAULT 0,  -- 被连累回队的次数
      keep_waits      INTEGER NOT NULL DEFAULT 0,  -- 「继续等」按了几次
      wait_started_at INTEGER NOT NULL,   -- 排队计时起点（「继续等」会重置它）
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_active
      ON match_tickets(user_id) WHERE state IN ('queued','formed','ready','seated');
    CREATE INDEX IF NOT EXISTS idx_ticket_queue
      ON match_tickets(mode, ruleset, state, wait_started_at);
    CREATE INDEX IF NOT EXISTS idx_ticket_match ON match_tickets(match_id);

    CREATE TABLE IF NOT EXISTS matches (
      id           TEXT PRIMARY KEY,
      mode         TEXT NOT NULL,
      ruleset      TEXT NOT NULL,
      seed         INTEGER NOT NULL,
      state        TEXT NOT NULL,        -- formed | ready | playing | closed
      room_id      TEXT,                 -- host 回报的造化房间 id（只下发给本局成员）
      room_code    TEXT,
      deadline     INTEGER,              -- formed/ready 阶段的截止时刻；playing 后置空
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      close_reason TEXT                -- cancelled | timeout | failed:xxx
    );
    CREATE INDEX IF NOT EXISTS idx_matches_state ON matches(state, deadline);

    -- ========== 开局装备快照（2026-11-24） ==========
    -- 为什么需要它：帧同步要求「这一局每个人带进来的背包/星图」在两端逐位一致，
    -- 而它不能靠进房后各自上报 —— reportSeated 只要求"报过到"，
    -- **不要求连接还活着**。所以先入座的人可以在最后一个人入座前关掉页面：
    -- 撮合服照样判定「全员到齐」，局照开，而那个人永远不会再上报 loadout。
    --
    -- 于是改成「点匹配那一刻就上传、由服务端存住」：
    --   pending_loadouts  排队期的暂存（一人一份，重复入队覆盖）
    --   match_loadouts    配对成功时固化（此后改装备不影响本局）
    -- relay 进局后按 matchId 拉取，填 players[].snapshot。
    CREATE TABLE IF NOT EXISTS pending_loadouts (
      user_id      TEXT PRIMARY KEY,
      platform_id  TEXT,               -- 造化 playerId（能拿到就存，用来和 relay 名单对齐）
      display_name TEXT,
      payload      TEXT NOT NULL,      -- 客户端 loadout 的 JSON
      bytes        INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS match_loadouts (
      match_id     TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      platform_id  TEXT,
      display_name TEXT,
      payload      TEXT NOT NULL,
      bytes        INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (match_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_loadouts_match ON match_loadouts(match_id);
  `)
}

// 单事务包装：node:sqlite 没有内置 transaction 辅助，手写 BEGIN/COMMIT/ROLLBACK
export function tx (fn) {
  const d = get()
  d.exec('BEGIN IMMEDIATE')
  try {
    const r = fn(d)
    d.exec('COMMIT')
    return r
  } catch (e) {
    try { d.exec('ROLLBACK') } catch {}
    throw e
  }
}

export function balanceOf (userId) {
  const row = get().prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId)
  return row ? row.balance : 0
}

// 唯一的余额变更入口。delta 为负时依赖 CHECK 约束兜住透支
export function applyDelta (userId, delta, reason, ref = null) {
  return tx((d) => applyDeltaNoTx(d, userId, delta, reason, ref))
}

// 给「已经在事务里」的调用方用（撮合要在一个事务里改多张表 + 多个人的余额，
// SQLite 不支持嵌套 BEGIN，所以必须能拿到 d 自己写）
export function applyDeltaNoTx (d, userId, delta, reason, ref = null) {
  d.prepare('INSERT OR IGNORE INTO wallets (user_id, balance) VALUES (?, 0)').run(userId)
  d.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(delta, userId)
  d.prepare('INSERT INTO ledger (user_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)')
    .run(userId, delta, reason, ref, Date.now())
  const row = d.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(userId)
  return row ? row.balance : 0
}

export function recentLedger (userId, limit = 20) {
  return get()
    .prepare('SELECT id, delta, reason, ref, created_at AS at FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit)
}

// 定期清理过期会话，避免表无限长
export function sweep () {
  const now = Date.now()
  return tx((d) => {
    const b = d.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
    return Number(b.changes)
  })
}

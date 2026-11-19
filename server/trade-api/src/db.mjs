// 数据库层：node:sqlite（Node 22 内置，零依赖）
// 设计要点：
//   1. user_id 由公钥派生 —— 密钥即账号，换浏览器导入同一私钥就回到同一账号（无邮箱无密码）
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

function migrate () {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      user_id     TEXT PRIMARY KEY,
      display     TEXT NOT NULL,
      pubkey      TEXT NOT NULL UNIQUE,
      created_at  INTEGER NOT NULL,
      banned      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS challenges (
      nonce       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      used        INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_challenges_user ON challenges(user_id);

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

// 定期清理过期数据，避免表无限长
export function sweep () {
  const now = Date.now()
  return tx((d) => {
    const a = d.prepare('DELETE FROM challenges WHERE expires_at < ?').run(now)
    const b = d.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
    return Number(a.changes) + Number(b.changes)
  })
}

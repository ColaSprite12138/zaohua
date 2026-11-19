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
  return tx((d) => {
    d.prepare('INSERT OR IGNORE INTO wallets (user_id, balance) VALUES (?, 0)').run(userId)
    d.prepare('UPDATE wallets SET balance = balance + ? WHERE user_id = ?').run(delta, userId)
    d.prepare('INSERT INTO ledger (user_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)')
      .run(userId, delta, reason, ref, Date.now())
    return balanceOf(userId)
  })
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

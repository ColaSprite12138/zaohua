// 数据清理：过期会话 + 历史游客账号（含其全部关联行）
//
// 为什么要有它：
//   1) 账号体系已收敛为「只有用户名 + 口令」，服务器上不再有任何设备密钥 /
//      签名 nonce 表（旧版本建过的 device_keys、challenges 已在启动迁移时删表）。
//      历史版本还建过游客账号 —— 它们没有口令，谁都登录不进来，只会无限堆积。
//   2) sessions 的行不会自己消失：7 天后 expires_at 过期，但记录还在。
//      PIPL 的「存储期限最小化」要求过期凭证不该长期保留。
//
// 用法（在 /opt/colasprite-api 下）：
//   node prune.mjs                 # 只清过期会话
//   node prune.mjs --guests        # 额外清掉所有游客账号
//   node prune.mjs --guests --dry  # 只报数，不删
//
// 顺序不能变：先删引用行再删 accounts，否则 FK 会拦（wallets 有 REFERENCES）。

import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dbPath = process.argv.includes('--db')
  ? process.argv[process.argv.indexOf('--db') + 1]
  : path.join(here, 'data', 'app.db')

const dry = process.argv.includes('--dry')
const withGuests = process.argv.includes('--guests')

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys = ON')

const now = Date.now()
const count = (sql, ...args) => db.prepare(sql).get(...args).c

const expiredSessions = count('SELECT COUNT(*) AS c FROM sessions WHERE expires_at < ?', now)
const guests = count("SELECT COUNT(*) AS c FROM accounts WHERE kind = 'guest' OR password_hash IS NULL")

console.log(`db          = ${dbPath}`)
console.log(`过期会话    = ${expiredSessions}`)
console.log(`无口令账号  = ${guests}${withGuests ? '' : '（未指定 --guests，不动）'}`)

if (dry) {
  console.log('--dry：只报数，没有改动')
  process.exit(0)
}

// 先删非 accounts 的引用行；accounts 最后删。
const guestScoped = ['saves', 'sessions', 'wallets', 'ledger', 'book_orders', 'listings', 'claims', 'trades']
const GUEST_IDS = "SELECT user_id FROM accounts WHERE kind = 'guest' OR password_hash IS NULL"

db.exec('BEGIN')
try {
  const removedSessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now).changes
  let removedGuests = 0
  if (withGuests) {
    for (const table of guestScoped) {
      // listings / claims / trades 里 user_id 字段名不同，逐张表判断
      const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name)
      const targets = ['user_id', 'buyer_id', 'seller_id'].filter((c) => cols.includes(c))
      for (const col of targets) {
        const r = db.prepare(`DELETE FROM ${table} WHERE ${col} IN (${GUEST_IDS})`).run()
        if (r.changes) console.log(`  ${table}.${col.padEnd(9)} -${r.changes}`)
      }
    }
    removedGuests = db.prepare("DELETE FROM accounts WHERE kind = 'guest' OR password_hash IS NULL").run().changes
    console.log(`  accounts     -${removedGuests}`)
  }
  db.exec('COMMIT')
  console.log(`完成：过期会话 -${Number(removedSessions)}${withGuests ? `，无口令账号 -${removedGuests}` : ''}`)
} catch (err) {
  db.exec('ROLLBACK')
  console.error('清理失败，已回滚：', err)
  process.exit(1)
}

// 自检：外键不应再有悬空引用
const bad = db.prepare('PRAGMA foreign_key_check').all()
console.log(bad.length ? `⚠ 外键悬空 ${bad.length} 条` : '外键检查：干净')
db.close()

// 交易所钱包：玩家先把金币「存进」交易所，交易只在寄存余额里发生。
//
// 为什么要托管而不是「成交时直接扣本地金币」：
//   本地存档在玩家机器上，服务端读不到也验不了。A 在成交瞬间不扣款，服务端无从察觉。
//   托管之后，服务端只面对自己写过的数字，成交永远可原子完成。
//
// ⚠️ 必须坦白的边界：这套能保证「交易所内部记账可信」，保证不了「入库的金币是真的」。
//   玩家声称有 1000 金要存，服务端无法验证 —— 这是单机存档游戏的固有洞，交易行堵不上。
//   所以这里用「单次上限 + 24 小时滚动上限 + 全量流水」把损失面收窄，不做虚假承诺。

import { applyDelta, balanceOf, get } from './db.mjs'
import { HttpError } from './errors.mjs'

export const limits = {
  maxSingle: 100_000,     // 单次存入上限
  maxDaily: 300_000       // 24 小时滚动存入上限
}

const DAY = 24 * 3600 * 1000

export function rolling24hDeposit (userId) {
  const row = get()
    .prepare("SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE user_id = ? AND reason = 'deposit' AND created_at > ?")
    .get(userId, Date.now() - DAY)
  return Number(row.s)
}

export function deposit (userId, amount) {
  if (amount > limits.maxSingle) {
    throw new HttpError(400, 'amount_too_large', `单次存入不能超过 ${limits.maxSingle}`)
  }
  const already = rolling24hDeposit(userId)
  if (already + amount > limits.maxDaily) {
    throw new HttpError(429, 'deposit_daily_limit', `24 小时内最多存入 ${limits.maxDaily}，已存 ${already}`)
  }
  const balance = applyDelta(userId, amount, 'deposit', null)
  return {
    balance,
    deposited: amount,
    rolling24hDeposited: already + amount,
    limits
  }
}

export function withdraw (userId, amount) {
  try {
    const balance = applyDelta(userId, -amount, 'withdraw', null)
    return { balance, withdrawn: amount }
  } catch (e) {
    // SQLite 的 CHECK (balance >= 0) 失败 —— 余额不足
    if (/CHECK constraint/i.test(e.message || '')) {
      throw new HttpError(400, 'insufficient_balance', `余额不足，当前 ${balanceOf(userId)}`)
    }
    throw e
  }
}

export { balanceOf }

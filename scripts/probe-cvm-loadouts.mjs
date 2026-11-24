#!/usr/bin/env node
/**
 * relay 拉取 CVM 开局快照的链路探针（本地，不需要平台）。
 *
 * 它把「CVM」换成本机一个 HTTP stub，验证 relay 侧的完整逻辑：
 *   客户端报 matchId → relay 请求 `/api/v1/match/:id/loadouts` → 按
 *   platformId / displayName 填 `players[].snapshot` → 随广播下发。
 *
 * 重点验证两条容易写反的规则：
 *   1. **客户端 deploy 后上报的那份要能覆盖 CVM 那份**（在场者以真实上报为准）；
 *   2. 没人上报的人保留 CVM 那份（这就是「当事人离线也能开局」）。
 *
 * 跑法：pnpm build:server && node scripts/probe-cvm-loadouts.mjs
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const loadoutA = {
  loadout: {
    bag: [{ uid: 'a-1', defId: '10001', container: 'bag', col: 0, row: 0 }],
    equipped: [null, null, null, null, null, null, null, null, null, null],
    activeWeaponSlot: 0,
    safe: [],
  },
  stars: { nodes: [], skills: ['fireball'] },
}
const loadoutB = {
  loadout: { bag: [], equipped: [null, null, null, null, null, null, null, null, null, null], activeWeaponSlot: 0, safe: [] },
  stars: { nodes: [], skills: [] },
}

/** 假的 CVM：只回一个固定响应，够验 relay 的解析与匹配。 */
const stub = createServer((req, res) => {
  if (req.url === '/api/v1/match/m-test-1234/loadouts') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      matchId: 'm-test-1234',
      // 世界参数：种子与模式必须由服务端下发（runSeed / runKind 进 hash）。
      seed: 12345,
      mode: 'extract',
      members: [
        // A 用 platformId 对齐；B 只给名字，走兜底。
        { userId: 'u-a', platformId: 'seat-a', displayName: '甲', loadout: JSON.stringify(loadoutA) },
        { userId: 'u-b', platformId: null, displayName: '乙', loadout: JSON.stringify(loadoutB) },
      ],
    }))
    return
  }
  res.writeHead(404).end('{}')
})
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
const port = stub.address().port
process.env.CVM_BASE = `http://127.0.0.1:${port}`

let captured = null
globalThis.PlatformServer = { stateSync: { createRuntime(o) { captured = o } } }
await import(pathToFileURL(path.join(ROOT, 'game/server/dist/index.js')).href)

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail === undefined ? '' : `  ${detail}`}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let game = null

// ---- 场景 1：只报 matchId，谁都没上报自己的快照 ----
{
  game = captured.createGame([{ id: 'seat-a', name: '甲' }, { id: 'seat-b', name: '乙' }])
  game.start()
  await sleep(60)
  const before = game.getState()
  check('还没报 matchId 时 cvmLoadouts = skipped', before.stats.cvmLoadouts === 'skipped',
    before.stats.cvmLoadouts)
  check('种子/关卡类型在拉到之前是 null（客户端不许自己定）',
    before.seed === null && before.kind === null, `${before.seed}/${before.kind}`)

  game.applyAction('seat-a', { matchId: 'm-test-1234' })
  for (let i = 0; i < 40 && game.getState().stats.cvmLoadouts === 'pending'; i += 1) await sleep(50)
  const after = game.getState()
  check('拉到并匹配上两人', after.stats.cvmLoadouts === 'ok:2/2', after.stats.cvmLoadouts)
  check('按 platformId 对齐的那个拿到了快照',
    JSON.stringify(after.players[0].snapshot) === JSON.stringify(loadoutA),
    JSON.stringify(after.players[0].snapshot).slice(0, 60))
  check('只给了名字的那个也拿到了（displayName 兜底）',
    JSON.stringify(after.players[1].snapshot) === JSON.stringify(loadoutB))
  check('快照随广播下发（有 snapshotUntil 窗口内）',
    after.players.every((p) => p.snapshot !== undefined))
  check('种子与关卡类型由服务端下发（runSeed / runKind 进 hash）',
    after.seed === 12345 && after.kind === 'pvpve', `${after.seed}/${after.kind}`)
  game.stop?.()
}

// ---- 场景 2：客户端再上报自己的快照，必须被忽略（单一数据源）----
{
  game = captured.createGame([{ id: 'seat-a', name: '甲' }])
  game.start()
  await sleep(60)
  game.applyAction('seat-a', { matchId: 'm-test-1234' })
  for (let i = 0; i < 40 && game.getState().stats.cvmLoadouts === 'pending'; i += 1) await sleep(50)

  const own = {
    loadout: { bag: [], equipped: [null, null, null, null, null, null, null, null, null, null], activeWeaponSlot: 0, safe: [] },
    hpMax: 132, manaMax: 80, starSkills: ['x'],
  }
  game.applyAction('seat-a', { snapshot: own })
  const after = game.getState()
  check('客户端上报**不覆盖** CVM 那份（单一数据源，用户 2026-11-24 拍板）',
    JSON.stringify(after.players[0].snapshot) === JSON.stringify(loadoutA),
    JSON.stringify(after.players[0].snapshot).slice(0, 60))
  check('旧上报只计数，供排障确认还剩多少旧客户端', after.stats.clientSnapshots === 1,
    after.stats.clientSnapshots)
  game.stop?.()
}

// ---- 场景 3：CVM 404 时安静降级，不影响出帧 ----
{
  game = captured.createGame([{ id: 'seat-a', name: '甲' }])
  game.start()
  await sleep(60)
  const f0 = game.getState().frame
  game.applyAction('seat-a', { matchId: 'm-missing-9999' })
  for (let i = 0; i < 30 && game.getState().stats.cvmLoadouts === 'pending'; i += 1) await sleep(50)
  const after = game.getState()
  check('404 记成 bad:404 而不是卡在 pending', after.stats.cvmLoadouts === 'bad:404',
    after.stats.cvmLoadouts)
  check('拉取失败仍照常出帧（降级不影响对局）', after.frame > f0, `${f0} → ${after.frame}`)
  game.stop?.()
}

// ---- 场景 4：CVM 响应比第二个玩家进房更早 ----
// 用户 2026-11-24 实测「有队友未同步装备快照（1 人）」：relay 收到 matchId 时
// 名单里只有一个人，第一次拉取只能填一份；后进房的人必须靠**缓存的 roster**
// 补上，不能再依赖「再拉一次」的网络时序。
{
  game = captured.createGame([{ id: 'seat-a', name: '甲' }])
  game.start()
  await sleep(60)
  game.applyAction('seat-a', { matchId: 'm-test-1234' })
  for (let i = 0; i < 40 && game.getState().stats.cvmLoadouts === 'pending'; i += 1) await sleep(50)
  const first = game.getState()
  check('名单只有一个人时只填一份', first.players[0].snapshot !== undefined, first.stats.cvmLoadouts)

  // 第二个玩家此刻才进房。他没有再触发一次网络请求：直接吃 roster。
  game.addPlayer({ id: 'seat-b', name: '乙' })
  const late = game.getState()
  check('后进房的人靠缓存 roster 补上快照（不再缺 1 人）',
    JSON.stringify(late.players[1].snapshot) === JSON.stringify(loadoutB),
    JSON.stringify(late.players[1].snapshot).slice(0, 60))
  check('补填后角标刷新成全对上（不是停在第一次的 1/1）',
    late.stats.cvmLoadouts === 'ok:2/2', late.stats.cvmLoadouts)
  game.stop?.()
}

stub.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`}（${results.length} 项）`)
process.exit(failed.length === 0 ? 0 : 1)

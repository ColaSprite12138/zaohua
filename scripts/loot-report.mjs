// Loot production report: measures the REAL combat roll path against the
// authored weight table, with a fixed seed so CI can diff the output.
//
//   node --experimental-strip-types scripts/loot-report.mjs [--samples 31000] [--seed 12345] [--json]
//
// This script imports `assets/combat/loot.ts` directly (Node 22 strip-types),
// so the numbers below come from the same `rollLoot()` the game calls on every
// kill. There is NO mirrored copy of the algorithm here.
// `python scripts/export_tables.py --check` gates the source tables;
// `assets/combat/__tests__/loot.test.ts` asserts the distribution in CI.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  itemRow, makeRng, poolEntries, rollLoot, theoreticalDistribution,
} from '../assets/combat/loot.ts';
import { monster_loot } from '../assets/resource/generated/monster_loot.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
const SAMPLES = arg('--samples', 31000);
const SEED = arg('--seed', 0xc0ffee);
const asJson = argv.includes('--json');

const report = [];
let failures = 0;
for (const monster of monster_loot) {
  const monsterId = String(monster.id);
  const poolId = monster.loot_pool_id;
  const rng = makeRng(SEED);
  const counts = new Map();
  for (let i = 0; i < SAMPLES; i += 1) {
    const roll = rollLoot(monsterId, rng);
    const id = roll === null ? 'NONE' : roll.itemId;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const theory = theoreticalDistribution(poolId);
  const entries = poolEntries(poolId);
  const totalWeight = entries.reduce((n, e) => n + e.weight, 0);
  const rows = entries.map((e) => {
    const theoretical = theory[e.itemId] ?? 0;
    const observed = (counts.get(e.itemId) ?? 0) / SAMPLES;
    const drift = Math.abs(observed - theoretical);
    if (drift > 0.01) failures += 1;
    const row = itemRow(e.itemId);
    return {
      itemId: e.itemId,
      name: row?.name ?? '?',
      quality: row?.quality ?? '?',
      damageMin: row?.damage_min ?? null,
      damageMax: row?.damage_max ?? null,
      weight: e.weight,
      theoretical: Number((theoretical * 100).toFixed(2)),
      observed: Number((observed * 100).toFixed(2)),
      count: counts.get(e.itemId) ?? 0,
      driftPct: Number((drift * 100).toFixed(2)),
    };
  });
  const unmatched = SAMPLES - rows.reduce((n, r) => n + r.count, 0);
  if (unmatched > 0) failures += 1;
  report.push({
    monsterId, monsterName: monster.name, poolId, totalWeight, unmatched, rows,
  });
}

if (asJson) {
  console.log(JSON.stringify({ samples: SAMPLES, seed: SEED, report, failures }, null, 2));
} else {
  console.log(`掉落产出报告  samples=${SAMPLES}/池  seed=${SEED}  (固定种子，可复现)`);
  console.log('数据源: assets/resource/tables/*.xlsx → combat/loot.ts::rollLoot (真实战斗路径)');
  for (const group of report) {
    console.log(`\n${group.monsterName} (${group.monsterId}) → 掉落池 ${group.poolId}  总权重 ${group.totalWeight}`);
    console.log('  物品id  名称        品质   伤害范围    权重   理论%    实测%    数量   偏差%');
    for (const r of group.rows) {
      const dmg = `${r.damageMin}-${r.damageMax}`.padEnd(10);
      console.log(
        `  ${r.itemId}  ${r.name.padEnd(10)}  ${r.quality.padEnd(4)}  ${dmg}` +
        `  ${String(r.weight).padStart(4)}   ${String(r.theoretical).padStart(6)}` +
        `  ${String(r.observed).padStart(7)}  ${String(r.count).padStart(6)}` +
        `  ${String(r.driftPct).padStart(5)}`,
      );
    }
    if (group.unmatched) console.log(`  [ERROR] 未命中任何表内物品: ${group.unmatched}`);
  }
  console.log(`\n偏差 >1% 或漏项的条目: ${failures}`);
}
if (failures > 0) process.exitCode = 1;

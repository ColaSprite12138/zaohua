#!/usr/bin/env node
/**
 * 帧同步「本机上下文」静态守卫。
 *
 * 判定层 `F` 里出现 `s.me` / `isMe` / `s.camera`，等价于「两台机器跑两份逻辑」：
 * A 端读到 A 的座位与相机，B 端读到 B 的，同一个玩家在这一帧的演算结果
 * 必然不同。用户 2026-11-21 真机报的「B 看到 A 一直挥刀」「闪避后 B 看不到
 * A 移动」就是这类隐式上下文加上「计时器只推进本机」共同造成的。
 *
 * 这些字段只允许出现在 `V` 层（绘制 / 输入采集 / 只读投影），且必须在同一行
 * 或上面紧挨着的注释里写 `// view-only: 理由` 或 `// local-context-ok: 理由`
 * 显式豁免。**局外结算 / UI 面板 / 血条各随本机座位是合法的**，它们本来就不进
 * `S`、不进帧、不进 hash；本守卫只拦「世界演算按本机分流」。
 *
 * `s.player` 允许作为「当前按 id 排序迭代的玩家」上下文（由 `withPlayer()`
 * 绑定、对所有玩家逐字相同），但用预算制钉住数量：不许悄悄新增第一人称分支。
 *
 * 2026-11-22 补：`DIRS` 原来只扫 combat/net，**漏扫了输入装配所在的 `assets/game`**，
 * 而且禁则没覆盖「本机 input + 远端表」这种隐性分流 —— 那次 PVP 分叉就是在
 * 守卫全绿时漏过去的。现在按目录分预算，并显式禁止按本机 id 拆包。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['assets/combat', 'assets/net', 'assets/game'];
/**
 * 按目录分预算：combat/net 是判定层；game 是输入装配与 V 层，读本机实体
 * （结算退出 / 血条 / UI / 相机）合法，单独钉住数量即可。三个数都**只许降**。
 */
const PLAYER_CONTEXT_BUDGET = {
  'assets/combat': 113,
  'assets/net': 0,
  'assets/game': 34,
};

/** 纯 V 层文件：整个文件不参与世界演算，读本机相机 / 血条 / 面板都合法。 */
const V_ONLY_FILES = new Set(['assets/game/paint.ts']);

const FORBIDDEN = [
  { re: /(?<![A-Za-z0-9_])s\.me\b/g, name: 's.me（本机座位 id）' },
  { re: /\bisMe\b/g, name: 'isMe（本机 / 远端分支）' },
  // paint.ts 里 `s.camera` 有 5 处，全是绘制时的坐标平移，不是判定层输入。
  { re: /(?<![A-Za-z0-9_])s\.camera\b/g, name: 's.camera（本机视角）', vLayerOk: true },
  { re: /(?<![A-Za-z0-9_])remoteInputs\b/g, name: 'remoteInputs（本机 / 远端输入分流）' },
  { re: /\bcollectInputs\b/g, name: 'collectInputs（F 内自拼输入表）' },
  { re: /packet\.frames\.get\(\s*netPlayerId/g, name: '按本机 id 取输入帧' },
  { re: /\bpeerId\s*===\s*netPlayerId\b/g, name: '按本机 id 拆帧表' },
  { re: /inputs\.set\(\s*s\.player\.id/g, name: '本机特供输入入口' },
];
const PLAYER_CONTEXT = /(?<![A-Za-z0-9_])s\.player\b/g;
const EXEMPT = /\b(view-only|local-context-ok)\s*:/;

/** 去掉块注释与行注释，只留代码；同时保留原始行用于豁免判定。 */
function codeOf(lines) {
  let inBlock = false;
  return lines.map((raw) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) return '';
      line = line.slice(end + 2);
      inBlock = false;
    }
    // 同一行内的 /* ... */ 可能有多个。
    for (;;) {
      const start = line.indexOf('/*');
      if (start < 0) break;
      const end = line.indexOf('*/', start + 2);
      if (end < 0) { line = line.slice(0, start); inBlock = true; break; }
      line = line.slice(0, start) + line.slice(end + 2);
    }
    const lineComment = line.indexOf('//');
    return lineComment >= 0 ? line.slice(0, lineComment) : line;
  });
}

const files = [];
for (const dir of DIRS) {
  const abs = path.join(ROOT, dir);
  for (const name of readdirSync(abs)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    files.push({ dir, rel: `${dir}/${name}`, abs: path.join(abs, name) });
  }
}

const violations = [];
const playerContext = Object.fromEntries(DIRS.map((d) => [d, 0]));
for (const file of files) {
  const raw = readFileSync(file.abs, 'utf8').split(/\r?\n/);
  const code = codeOf(raw);
  code.forEach((line, i) => {
    if (line.trim() === '') return;
    for (const { re, name, vLayerOk } of FORBIDDEN) {
      re.lastIndex = 0;
      if (!re.test(line)) continue;
      if (vLayerOk && V_ONLY_FILES.has(file.rel)) continue;
      // 豁免写在当前行或它上面紧挨着的注释块里（多行说明很常见）。
      const nearby = raw.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (EXEMPT.test(nearby)) continue;
      violations.push(`${file.rel}:${i + 1} → ${name}\n    ${line.trim()}`);
    }
  });
  const contexts = (line) => (line.match(PLAYER_CONTEXT) ?? []).length;
  for (const line of code) playerContext[file.dir] += contexts(line);
}

if (violations.length > 0) {
  console.error('[FAIL] 判定层混进了「本机」概念，两端会跑成两份逻辑：');
  for (const v of violations) console.error('  ' + v);
  console.error('  V 层确需读取时，在同行或上一行写 // view-only: 理由');
  process.exit(1);
}
const over = DIRS.filter((d) => playerContext[d] > PLAYER_CONTEXT_BUDGET[d]);
if (over.length > 0) {
  for (const d of over) {
    console.error(`[FAIL] ${d} 的 s.player 迭代上下文 ${playerContext[d]} 处，超过预算 ${PLAYER_CONTEXT_BUDGET[d]}`);
  }
  console.error('  新读取前先问：能不能显式接一个 Player 参数？');
  process.exit(1);
}
const counts = DIRS.map((d) => `${d.replace('assets/', '')} ${playerContext[d]}/${PLAYER_CONTEXT_BUDGET[d]}`).join(' · ');
console.log(`[ OK ] 本机上下文守卫：s.me/isMe/s.camera/输入分流 0 处；s.player 迭代上下文 ${counts}`);

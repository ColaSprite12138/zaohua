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
 * 或上一行写 `// view-only: 理由` 或 `// local-context-ok: 理由` 显式豁免。
 *
 * `s.player` 允许作为「当前按 id 排序迭代的玩家」上下文（由 `withPlayer()`
 * 绑定、对所有玩家逐字相同），但用预算制钉住数量：不许悄悄新增第一人称分支。
 * 判定层也不该再出现「本机输入 vs 远端输入」的条件表达式。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['assets/combat', 'assets/net'];
/** 当前基线，只许降不许升。想新增 `s.player` 读取前先想清楚是不是该显式传 Player。 */
const PLAYER_CONTEXT_BUDGET = 113;

const FORBIDDEN = [
  { re: /(?<![A-Za-z0-9_])s\.me\b/g, name: 's.me（本机座位 id）' },
  { re: /\bisMe\b/g, name: 'isMe（本机 / 远端分支）' },
  { re: /(?<![A-Za-z0-9_])s\.camera\b/g, name: 's.camera（本机视角）' },
  { re: /(?<![A-Za-z0-9_])remoteInputs\?\.get\b/g, name: 'remoteInputs?.get（按本机分流输入）' },
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
    files.push({ rel: `${dir}/${name}`, abs: path.join(abs, name) });
  }
}

const violations = [];
let playerContext = 0;
for (const file of files) {
  const raw = readFileSync(file.abs, 'utf8').split(/\r?\n/);
  const code = codeOf(raw);
  code.forEach((line, i) => {
    if (line.trim() === '') return;
    for (const { re, name } of FORBIDDEN) {
      re.lastIndex = 0;
      if (!re.test(line)) continue;
      // 豁免写在当前行或它上面紧挨着的注释块里（多行说明很常见）。
      const nearby = raw.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (EXEMPT.test(nearby)) continue;
      violations.push(`${file.rel}:${i + 1} → ${name}\n    ${line.trim()}`);
    }
  });
  const contexts = (line) => (line.match(PLAYER_CONTEXT) ?? []).length;
  for (const line of code) playerContext += contexts(line);
}

if (violations.length > 0) {
  console.error('[FAIL] 判定层混进了「本机」概念，两端会跑成两份逻辑：');
  for (const v of violations) console.error('  ' + v);
  console.error('  V 层确需读取时，在同行或上一行写 // view-only: 理由');
  process.exit(1);
}
if (playerContext > PLAYER_CONTEXT_BUDGET) {
  console.error(`[FAIL] s.player 迭代上下文 ${playerContext} 处，超过预算 ${PLAYER_CONTEXT_BUDGET}`);
  console.error('  新读取前先问：能不能显式接一个 Player 参数？');
  process.exit(1);
}
console.log(`[ OK ] 本机上下文守卫：s.me/isMe/s.camera/输入分流 0 处；s.player 迭代上下文 ${playerContext} / ${PLAYER_CONTEXT_BUDGET}`);

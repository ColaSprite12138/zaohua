// 把 meta-ui/art 里的 WebP 图片内联进 meta-ui/index.html 的 CSS。
// 用法: node scripts/inline-art.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const htmlPath = path.join(root, 'meta-ui/index.html');
let h = fs.readFileSync(htmlPath, 'utf8');

const items = [
  {
    key: 'pvpve',
    webp: 'meta-ui/art/icon-pvpve.webp',
    // 卡片图标：替换原来的简笔画 SVG data URI
    match: /(\.kind-card\[data-kind="pvpve"\]::before\s*\{[^}]*?background-image:\s*)url\("data:image\/svg\+xml,[^"]*"\)(;[^}]*\})/,
  },
  {
    key: 'dungeon',
    webp: 'meta-ui/art/icon-dungeon.webp',
    match: /(\.kind-card\[data-kind="dungeon"\]::before\s*\{[^}]*?background-image:\s*)url\("data:image\/svg\+xml,[^"]*"\)(;[^}]*\})/,
  },
  {
    key: 'story',
    webp: 'meta-ui/art/icon-story.webp',
    match: /(\.kind-card\[data-kind="story"\]::before\s*\{[^}]*?background-image:\s*)url\("data:image\/svg\+xml,[^"]*"\)(;[^}]*\})/,
  },
];

for (const it of items) {
  const p = path.join(root, it.webp);
  if (!fs.existsSync(p)) throw new Error(`missing ${it.webp} — 先跑 python 压缩脚本`);
  const b64 = fs.readFileSync(p).toString('base64');
  const m = h.match(it.match);
  if (!m) throw new Error(`CSS selector not found for ${it.key}`);
  h = h.replace(it.match, `$1url("data:image/webp;base64,${b64}")$2`);
  console.log(`[OK] inline icon-${it.key} (${fs.statSync(p).size} bytes)`);
}

fs.writeFileSync(htmlPath, h);
console.log(`[OK] ${htmlPath} (${h.length} chars)`);

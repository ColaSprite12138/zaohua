/**
 * Independent browser acceptance for the standalone meta UI.
 *
 *   node scripts/verify-meta-ui.cjs
 *
 * meta-ui/index.html must work when double-clicked (file://, no server, no
 * bundler). This script builds a temporary copy with an in-page drag/drop
 * self-test, renders it in headless Chrome, and asserts the RESULT — not just
 * that the DOM exists. Called by `scripts/verify.sh` when meta changed.
 *
 * The self-test fires real DragEvent/DataTransfer sequences, so placement,
 * collision rejection, cross-container moves, equipping, hotkey switching and
 * slot type checks are all exercised through the page's actual event handlers.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pagePath = path.join(root, 'meta-ui/index.html');
const outDir = path.join(root, 'artifacts/verify');
fs.mkdirSync(outDir, { recursive: true });
const testPage = path.join(outDir, 'meta-ui-selftest.html');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) {
  console.error('[FAIL] Chrome not found. Set CHROME_PATH to chrome.exe.');
  process.exit(1);
}

const SELFTEST = `
<div id="selftest-result">PENDING</div>
<script>
(function () {
  const out = { steps: {} };
  document.title = 'SELFTEST_STARTED';
  window.addEventListener('error', (e) => {
    document.title = 'SELFTEST_ERROR:' + String(e.message);
    document.getElementById('selftest-result').textContent = JSON.stringify({ ok: false, error: String(e.message) });
  });
  try {
    const $ = (id) => document.getElementById(id);
    const status = () => $('status').textContent;
    const trayCount = () => document.querySelectorAll('.tray, .loose-item').length;
    const bagCount = () => document.querySelectorAll('#wrap-bag .grid-item').length;
    const stashCount = () => document.querySelectorAll('#wrap-stash .grid-item').length;
    const filled = () => document.querySelectorAll('.equip-slot.filled').length;
    const activeIdx = () => [...document.querySelectorAll('.equip-slot')]
      .findIndex((n) => n.classList.contains('active'));
    const cells = (c) => document.querySelectorAll('#grid-' + c + ' .cell').length;
    const fire = (node, type, x, y, data) => {
      if (!node) throw new Error('missing drag node for ' + type);
      node.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: data,
      }));
    };
    const snap = (tag) => {
      out.steps[tag] = {
        tray: trayCount(), bag: bagCount(), stash: stashCount(),
        filled: filled(), active: activeIdx(), status: status(),
      };
    };
    const dragToGrid = (fromNode, container, col, row) => {
      const grid = $('grid-' + container), wrap = $('wrap-' + container);
      const size = container === 'bag' ? 46 : 34;
      const r = grid.getBoundingClientRect();
      const x = r.left + col * size + size / 2;
      const y = r.top + row * size + size / 2;
      const d = new DataTransfer();
      // dragstart must carry a cursor position ON THE SOURCE ITEM: the page
      // derives grabCol/grabRow from it to offset the drop cell.
      const fr = fromNode.getBoundingClientRect();
      fire(fromNode, 'dragstart', fr.left + 2, fr.top + 2, d);
      fire(wrap, 'dragover', x, y, d);
      fire(wrap, 'drop', x, y, d);
      fire(fromNode, 'dragend', x, y, d);
    };
    const dragToSlot = (fromNode, slotIndex) => {
      const slot = document.querySelector('.equip-slot[data-slot="' + slotIndex + '"]');
      const r = slot.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const d = new DataTransfer();
      fire(fromNode, 'dragstart', x, y, d);
      fire(slot, 'dragover', x, y, d);
      fire(slot, 'drop', x, y, d);
      fire(fromNode, 'dragend', x, y, d);
    };

    out.gridCells = { bag: cells('bag'), stash: cells('stash') };
    out.equipSlots = document.querySelectorAll('.equip-slot').length;
    // Items must be drawn as VOXEL MODELS, not as text: every item node has a
    // canvas, all of them actually painted pixels, and none fell back to glyphs.
    out.art = (() => {
      const canvases = [...document.querySelectorAll(
        '#wrap-stash canvas.art, #wrap-bag canvas.art, .equip-slot canvas.art',
      )];
      let painted = 0;
      for (const c of canvases) {
        const g = c.getContext('2d');
        if (!g || c.width < 8 || c.height < 8) continue;
        const data = g.getImageData(0, 0, c.width, c.height).data;
        let opaque = 0;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] > 0) { opaque += 1; if (opaque > 60) break; }
        }
        if (opaque > 60) painted += 1;
      }
      return {
        canvases: canvases.length,
        painted: painted,
        glyphs: document.querySelectorAll('.item .glyph, .equip-slot .glyph').length,
      };
    })();
    snap('initial');

    // stash -> bag (0,0): a 2x3 longsword fits a 5x8 bag.
    dragToGrid(document.querySelector('#wrap-stash .grid-item'), 'bag', 0, 0);
    snap('dropIntoBag');
    // Same cells again: overlapping footprint must be rejected atomically.
    dragToGrid(document.querySelector('#wrap-stash .grid-item'), 'bag', 0, 0);
    snap('overlapRejected');
    // Free spot (3,5): 3+2<=5 and 5+3<=8, so it fits.
    dragToGrid(document.querySelector('#wrap-stash .grid-item'), 'bag', 3, 5);
    snap('secondBagSlot');
    // Out of bounds (4,0): 4+2>5 must be rejected.
    dragToGrid(document.querySelector('#wrap-stash .grid-item'), 'bag', 4, 0);
    snap('boundsRejected');
    // bag -> stash: cross-container move.
    dragToGrid(document.querySelector('#wrap-bag .grid-item'), 'stash', 0, 0);
    snap('movedToStash');
    // stash -> weapon slot 0: equip.
    dragToSlot(document.querySelector('#wrap-stash .grid-item'), 0);
    snap('equipped');
    // Hotkeys 1 / 2 switch the active weapon slot.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));
    snap('key2');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    snap('key1');
    // Wrong-type equip: a sword cannot go into a ring slot.
    dragToSlot(document.querySelector('#wrap-stash .grid-item'), 2);
    snap('wrongTypeRejected');
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.stack) || e);
  }
  document.getElementById('selftest-result').textContent = JSON.stringify(out);
  document.title = out.ok ? 'SELFTEST_DONE' : 'SELFTEST_FAILED';
})();
</script>
`;

const source = fs.readFileSync(pagePath, 'utf8');
// Every classic <script src> the page needs must resolve from the TEMPORARY
// copy in artifacts/verify/, so pin both generated scripts to absolute paths.
const absOf = (f) => 'file:///' + path.join(root, 'meta-ui', f).replace(/\\/g, '/');
let html = source;
for (const [tag, file] of [
  ['./voxel.js', 'voxel.js'],
  ['./inventory.js', 'inventory.js'],
]) {
  const next = html.replace('<script src="' + tag + '"></script>', '<script src="' + absOf(file) + '"></script>');
  if (next === html) throw new Error('meta-ui/index.html no longer references ' + tag);
  html = next;
}
html = html.replace('</body>', SELFTEST + '</body>');
fs.writeFileSync(testPage, html, 'utf8');

const domPath = path.join(outDir, 'meta-ui-selftest-dom.html');
// An isolated profile is MANDATORY on Windows: without it chrome.exe hands the
// URL to an already-running Chrome process and --dump-dom returns a stale /
// half-executed DOM (the self-test div stays "PENDING"). See feedback #10.
const profile = path.join(outDir, 'meta-ui-chrome-' + process.pid);
const run = spawnSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--allow-file-access-from-files', '--virtual-time-budget=4000',
  '--user-data-dir=' + profile,
  '--dump-dom', 'file:///' + testPage.replace(/\\/g, '/'),
], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 90000 });

if (run.error) throw run.error;
fs.writeFileSync(domPath, run.stdout || '', 'utf8');

const decode = (s) => s
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
const match = (run.stdout || '').match(/<div id="selftest-result">([^<]*)<\/div>/);
if (!match) {
  console.error('[FAIL] self-test did not run (no #selftest-result in DOM)');
  process.exit(1);
}
let result;
try { result = JSON.parse(decode(match[1])); }
catch (e) {
  console.error('[FAIL] cannot parse self-test result:', match[1].slice(0, 300));
  process.exit(1);
}
if (!result.ok) {
  console.error('[FAIL] page threw:', result.error);
  process.exit(1);
}

const S = result.steps;
const checks = [
  ['bag renders 5x8 = 40 cells', result.gridCells.bag === 40, result.gridCells.bag],
  ['stash renders 16x10 = 160 cells', result.gridCells.stash === 160, result.gridCells.stash],
  ['ten equipment slots', result.equipSlots === 10, result.equipSlots],
  ['every stash item is drawn as a painted voxel model, not a glyph',
    result.art.canvases >= 3 && result.art.painted === result.art.canvases
      && result.art.glyphs === 0, result.art],
  ['starts with 3 swords in the stash and no loose tray', S.initial.stash === 3 && S.initial.bag === 0 && S.initial.tray === 0, S.initial],
  ['drag stash -> bag places one 2x3 item', S.dropIntoBag.bag === 1 && S.dropIntoBag.stash === 2, S.dropIntoBag],
  ['overlapping drop rejected without state change', S.overlapRejected.bag === 1 && S.overlapRejected.stash === 2 && /放不下/.test(S.overlapRejected.status), S.overlapRejected],
  ['a second sword fits a free 2x3 spot', S.secondBagSlot.bag === 2 && S.secondBagSlot.stash === 1, S.secondBagSlot],
  ['out-of-bounds drop rejected', S.boundsRejected.bag === 2 && S.boundsRejected.stash === 1, S.boundsRejected],
  ['bag -> stash cross-container drag', S.movedToStash.bag === 1 && S.movedToStash.stash === 2, S.movedToStash],
  ['stash -> weapon slot equips and frees the cell', S.equipped.filled === 1 && S.equipped.stash === 1, S.equipped],
  ['key 2 activates weapon slot 2', S.key2.active === 1, S.key2],
  ['key 1 activates weapon slot 1', S.key1.active === 0, S.key1],
  ['wrong-type equip into a ring slot rejected', S.wrongTypeRejected.filled === 1 && /不能穿戴/.test(S.wrongTypeRejected.status), S.wrongTypeRejected],
];

let failed = 0;
for (const [name, ok, actual] of checks) {
  console.log((ok ? '[ OK ] ' : '[FAIL] ') + name);
  if (!ok) { console.log('       actual: ' + JSON.stringify(actual)); failed += 1; }
}
console.log(`meta-ui browser acceptance: ${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exit(1);

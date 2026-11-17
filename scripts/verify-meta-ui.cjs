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

    out.gridCells = { bag: cells('bag'), stash: cells('stash'), safe: cells('safe') };
    // 保险格是**独立容器**（设计 4）：它有自己的两格，且不占背包的 40 格。
    out.gridCells.safePanel = !!document.getElementById('safe-panel')
      && getComputedStyle(document.getElementById('safe-panel')).display !== 'none';
    out.gridCells.insuredInBag = document.querySelectorAll('#grid-bag .cell.insured').length;
    out.equipSlots = document.querySelectorAll('.equip-slot').length;
    // 新开局仓库**是空的**（用户 2026-11-17：「把仓库初始三把长剑删掉」）。
    // 先拍这张空快照，再自己造演示长剑 —— 后面的拖拽用例不能依赖页面的初始数据。
    snap('initial');
    {
      const lobby = window.MetaShell.getLobbyState();
      for (let i = 0; i < 3; i += 1) {
        lobby.stash.push({
          uid: 'demo-' + (i + 1), defId: 'longsword', container: 'stash',
          col: i * 2, row: 0,
        });
      }
      window.MetaShell.render();
    }
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
    snap('seeded');

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
        // ---- 悬停信息卡：名字 / 属性 / 耐久（2026-11-15 用户要求） ----
    out.tip = {};
    (function () {
      const tip = document.getElementById('fx-item-tip');
      // 独立页没有注入物品目录（longsword 是代码里的演示物品，没有伤害/耐久），
      // 所以这里按表里的真实形状注册一件带属性的武器再悬停它。
      const MI = window.MetaInventory, HS = window.MetaShell;
      MI.registerItemDefs([{
        id: '10001', name: '巨剑', item_type: '武器', quality: '白',
        damage_min: 10, damage_max: 15, weapon_subtype: '近战', durability: 160,
      }]);
      MI.addToBag(HS.getLobbyState(), 'tip-probe', '10001');
      HS.render();
      const target = document.querySelector('#wrap-bag [data-tip-def="10001"]');
      if (!tip || !target) { out.tip.missing = true; return; }
      const rect = target.getBoundingClientRect();
      // 派发在**物品节点**上（和真实鼠标一样，target 是格子里的那个 div）。
      target.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      }));
      out.tip.visible = tip.hidden === false;
      out.tip.text = tip.textContent || '';
      out.tip.name = (tip.querySelector('.tip-name') || {}).textContent || '';
      out.tip.rows = [...tip.querySelectorAll('.tip-row')].map((n) => n.textContent);
      out.tip.bar = !!tip.querySelector('.tip-bar');
      out.tip.dmgLegacy = dmgRowText(tip);

      // 第二件：**带实例伤害**（掉落时掷定）。用户 2026-11-17：
      // 「面板还显示一个范围，没有显示随机后的值」—— 有实例值就必须只显示那一个数。
      MI.registerItemDefs([{
        id: '10006', name: '暗金巨剑', item_type: '武器', quality: '暗金',
        damage_min: 250, damage_max: 400, weapon_subtype: '近战', durability: 160,
      }]);
      MI.addToBag(HS.getLobbyState(), 'tip-probe-2', '10006', undefined, undefined, 271);
      HS.render();
      const target2 = document.querySelector('#wrap-bag [data-tip-uid="tip-probe-2"]');
      if (target2) {
        const r2 = target2.getBoundingClientRect();
        target2.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, clientX: r2.left + r2.width / 2, clientY: r2.top + r2.height / 2,
        }));
        out.tip.dmgRolled = dmgRowText(tip);
      }
      // 移开必须收起，否则卡片会一直挂在屏幕上
      document.body.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: 2, clientY: 2,
      }));
      out.tip.hiddenAfterLeave = tip.hidden === true;

      function dmgRowText(el) {
        const row = [...el.querySelectorAll('.tip-row')].find((n) => /伤害/.test(n.textContent));
        return row ? row.textContent.trim() : '';
      }
    })();
    // ---- 商店（设计 5.2）：金币买药 / 保险格付费扩容 ----
    // 价目表由宿注入（见文件末尾的预注入块），所以这里走的是真实规则与真实按钮。
    out.shop = (function () {
      const MI = window.MetaInventory, HS = window.MetaShell;
      const potionCells = () => [...document.querySelectorAll('#wrap-bag .grid-item')]
        .filter((n) => n.dataset.tipDef === '30002');
      // 面板默认展开；点一次应当收起、再点一次回来（按钮没有变成摆设）。
      const panel = document.getElementById('shop-panel');
      const openByDefault = !panel.hidden;
      document.getElementById('shop-toggle').click();
      const collapsed = panel.hidden;
      document.getElementById('shop-toggle').click();
      const reopened = !panel.hidden;
      const offers = document.querySelectorAll('.shop-offer').length;
      const gold0 = HS.wallet ? HS.wallet.gold : -1;
      const bagBefore = HS.getLobbyState().bag.length;
      // 没钱买不到：金币清零后点一下，背包不能多东西。
      HS.wallet.gold = 0;
      HS.render();
      const hp = document.querySelector('.shop-offer[data-offer="potion_hp"]');
      // 买不起时按钮必须是**禁用**的（点了也不会发购买命令），并且角标写着"金币不足"。
      const hpDisabled = hp.disabled;
      const hpLabel = (hp.querySelector('.so-state') || {}).textContent || '';
      hp.click();
      const refused = hpDisabled && /金币不足/.test(hpLabel)
        && HS.getLobbyState().bag.length === bagBefore;
      // 有钱：买两瓶红药，第二瓶必须并进同一格（堆叠走的是真实购买路径）。
      HS.wallet.gold = 500;
      HS.render();
      document.querySelector('.shop-offer[data-offer="potion_hp"]').click();
      document.querySelector('.shop-offer[data-offer="potion_hp"]').click();
      const cellsUsed = potionCells().length;
      const badge = (potionCells()[0] && potionCells()[0].querySelector('.stack-count') || {}).textContent || '';
      // 保险格扩容：买 3 格那一档，网格真的变宽。
      document.querySelector('.shop-offer[data-offer="safe_3"]').click();
      return {
        offers: offers,
        openByDefault: openByDefault,
        collapses: collapsed && reopened,
        gold0: gold0,
        refused: refused,
        cells: cellsUsed,
        badge: badge,
        safeCells: cells('safe'),
        safeCols: MI.safeColsOf(HS.getLobbyState()),
        gold: HS.wallet.gold,
      };
    })();
    // ---- 工坊（设计 5.2）：重铸词条 + 修耐久 ----
    // 夹具是一件**真武器**（紫巨剑）：白装没词条洗不了、也没耐久上限，验不了这两条。
    // 词条池来自 generated/affix.ts（见文件末尾的预注入），掷骰走页面的真实路径。
    out.workshop = (function () {
      const MI = window.MetaInventory, HS = window.MetaShell;
      HS.wallet.gold = 1000;
      const seed = { id: 'keen', stat: 'dmg_pct', value: 0.06 };
      MI.addToBag(HS.getLobbyState(), 'ws-purple', '10004', 60, [seed]);
      HS.render();

      const panel = document.getElementById('workshop-panel');
      const hiddenByDefault = panel.hidden === true;
      document.getElementById('workshop-toggle').click();
      const allRows = () => [...document.querySelectorAll('.ws-row')];
      const mine = () => allRows().find((n) => n.dataset.uid === 'ws-purple');
      const rowCount = allRows().length;
      const btn = (row, act) => row.querySelector('[data-act="' + act + '"]');

      const labels = {
        reforge: btn(mine(), 'reforge').textContent,
        repair: btn(mine(), 'repair').textContent,
      };

      // 重铸：扣 260、词条必须**换一种且立刻生效**（没有确认框）。
      btn(mine(), 'reforge').click();
      const afterR = HS.getLobbyState().bag.find((i) => i.uid === 'ws-purple');
      const reforged = {
        gold: HS.wallet.gold,
        reforges: afterR.reforges,
        affixCount: (afterR.affixes || []).length,
        changed: JSON.stringify(afterR.affixes) !== JSON.stringify([seed]),
        durability: afterR.durability,
        durabilityMax: afterR.durabilityMax,
        btnDisabled: btn(mine(), 'reforge').disabled,
        btnLabel: btn(mine(), 'reforge').textContent,
      };

      // 修理：耐久回满，但上限从 160 永久磨到 135（补 100 掉 25）。
      const repairLabel = btn(mine(), 'repair').textContent;
      btn(mine(), 'repair').click();
      const afterP = HS.getLobbyState().bag.find((i) => i.uid === 'ws-purple');
      // 列表只列「现在能做点什么」的东西：洗过 + 修满之后，这一行应当**整条消失**
      // —— 这比"按钮变灰"更能说明状态机走完了（也顺带证明列表不是静态 HTML）。
      const repaired = {
        durability: afterP.durability,
        durabilityMax: afterP.durabilityMax,
        repairs: afterP.repairs,
        gold: HS.wallet.gold,
        label: repairLabel,
        rowGone: mine() === undefined,
      };
      return { hiddenByDefault, rowCount, labels, reforged, repaired };
    })();
    // 给截图留一件**待处理**的装备（紫巨剑、耐久 70/160、带词条）：工坊那一张图要
    // 看得见「重铸 260 / 修 …」两个按钮，而不是空列表。
    (function () {
      const HS = window.MetaShell;
      const lobby = HS.getLobbyState ? HS.getLobbyState() : HS.state;
      // 放**仓库**（空位多、也不占背包的拖拽用例留下的空间）。
      lobby.stash.push({
        uid: 'ws-shot', defId: '10004', container: 'stash', col: 0, row: 4,
        durability: 70, affixes: [{ id: 'brutal', stat: 'dmg_pct', value: 0.11 }],
      });
      HS.render();
      const panel = document.getElementById('workshop-panel');
      if (panel.hidden) document.getElementById('workshop-toggle').click();
    })();
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

// 价目表与两个可堆叠物品的 def 在**页面脚本之前**注入（页面的 `SHOP_ROWS` 是
// 初始化时读一次的快照，`registerItemDefs` 也只会在启动时跑）。数据来自生成物，
// 所以这里没有第二份价格。
const readGenerated = (file) => {
  const body = fs.readFileSync(path.join(root, 'assets/resource/generated', file), 'utf8')
    .replace(/^[\s\S]*?export const \w+ = /, '')
    .replace(/\n\] as const;[\s\S]*$/, '\n]');
  return JSON.parse(body.replace(/([a-z_]+):/g, '"$1":').replace(/,\s*\]$/, ']'));
};
const shopRows = readGenerated('shop.ts');
const workshopRows = readGenerated('workshop.ts');
const affixRows = readGenerated('affix.ts');
const preset = JSON.stringify({
  shop: shopRows,
  workshop: workshopRows,
  affix: affixRows,
  authoredItems: [
    { id: '30002', name: '红药', item_type: '消耗品', stack_size: 5 },
    { id: '30003', name: '蓝药', item_type: '消耗品', stack_size: 5 },
    // 工坊夹具要一件**有词条、有耐久上限**的真武器：白装两样都没有。
    {
      id: '10004', name: '紫巨剑', item_type: '武器', stack_size: 1,
      quality: '紫', durability: 160, damage_min: 100, damage_max: 120,
      weapon_subtype: '近战',
    },
  ],
});
let html = source;
for (const [tag, file] of [
  ['./voxel.js', 'voxel.js'],
  ['./inventory.js', 'inventory.js'],
  ['./talent.js', 'talent.js'],
  ['./affix.js', 'affix.js'],
  ['./trade.js', 'trade.js'],
  ['./shop.js', 'shop.js'],
  ['./workshop.js', 'workshop.js'],
]) {
  const next = html.replace('<script src="' + tag + '"></script>',
    '<script src="' + absOf(file) + '"></script>');
  if (next === html) throw new Error('meta-ui/index.html no longer references ' + tag);
  html = next;
}
// `window.MetaShell` 必须在页面自己的 <script> 里被读到，所以放在最前面。
html = html.replace('<script src="' + absOf('voxel.js') + '"></script>',
  '<script>window.MetaShell = ' + preset + ';</script>\n<script src="' + absOf('voxel.js') + '"></script>');
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

// 同一张测试页再跑一次截图（自测结束后的状态：背包里有 2 瓶红药叠成一格、
// 保险格已扩到 3 格、商店面板开着）。这条是**堆叠与商店的视觉证据**：
// `--dump-dom` 只能证明 DOM 里的角标文字，截图能证明它真的画在格子上。
const shotPath = path.join(outDir, 'meta-ui-workshop.png');
spawnSync(chrome, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--allow-file-access-from-files', '--virtual-time-budget=4000',
  '--user-data-dir=' + profile + '-shot',
  '--window-size=1400,1000',
  '--screenshot=' + shotPath,
  'file:///' + testPage.replace(/\\/g, '/'),
], { encoding: 'utf8', timeout: 90000 });

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
  ['保险格是独立容器：自己 2 格、有独立面板，背包里不再有「保险格」标记',
    result.gridCells.safe === 2 && result.gridCells.safePanel === true
      && result.gridCells.insuredInBag === 0, result.gridCells],
  ['ten equipment slots', result.equipSlots === 10, result.equipSlots],
  ['every stash item is drawn as a painted voxel model, not a glyph',
    result.art.canvases >= 3 && result.art.painted === result.art.canvases
      && result.art.glyphs === 0, result.art],
  // 用户 2026-11-17：「把仓库初始三把长剑删掉」—— 新开局仓库必须是空的。
  ['新开局仓库是空的（不再有初始三把长剑）', S.initial.stash === 0 && S.initial.bag === 0 && S.initial.tray === 0, S.initial],
  ['验收自造的 3 把演示长剑落在仓库里（后续拖拽用例的前提）', S.seeded.stash === 3 && S.seeded.bag === 0, S.seeded],
  ['drag stash -> bag places one 2x3 item', S.dropIntoBag.bag === 1 && S.dropIntoBag.stash === 2, S.dropIntoBag],
  ['overlapping drop rejected without state change', S.overlapRejected.bag === 1 && S.overlapRejected.stash === 2 && /放不下/.test(S.overlapRejected.status), S.overlapRejected],
  ['a second sword fits a free 2x3 spot', S.secondBagSlot.bag === 2 && S.secondBagSlot.stash === 1, S.secondBagSlot],
  ['out-of-bounds drop rejected', S.boundsRejected.bag === 2 && S.boundsRejected.stash === 1, S.boundsRejected],
  ['bag -> stash cross-container drag', S.movedToStash.bag === 1 && S.movedToStash.stash === 2, S.movedToStash],
  ['stash -> weapon slot equips and frees the cell', S.equipped.filled === 1 && S.equipped.stash === 1, S.equipped],
  ['key 2 activates weapon slot 2', S.key2.active === 1, S.key2],
  ['key 1 activates weapon slot 1', S.key1.active === 0, S.key1],
  ['wrong-type equip into a ring slot rejected', S.wrongTypeRejected.filled === 1 && /不能穿戴/.test(S.wrongTypeRejected.status), S.wrongTypeRejected],
  ['悬停物品显示名字 / 属性 / 耐久（移开即收起）',
    result.tip.visible === true
      && result.tip.name === '巨剑'
      && result.tip.rows.some((t) => /伤害/.test(t))
      && result.tip.rows.some((t) => /耐久/.test(t))
      && result.tip.bar === true
      && result.tip.hiddenAfterLeave === true, result.tip],
  // 用户 2026-11-17：卡片必须显示**掷定后的那一个数**，不再是表里的区间。
  ['商店：金币够才买得到；两瓶红药并成一格（×2 角标）',
    result.shop.offers >= 5 && result.shop.gold0 === 120
      && result.shop.openByDefault === true && result.shop.collapses === true
      && result.shop.refused === true
      && result.shop.cells === 1 && result.shop.badge === '×2', result.shop],
  ['商店：保险格付费扩容把网格从 2 格变成 3 格',
    result.shop.safeCells === 3 && result.shop.safeCols === 3
      && result.shop.gold === 500 - 50 - 250, result.shop],
  ['工坊：重铸扣 260 直接换词条，洗过就锁死（不能二选一、不能再洗）',
    result.workshop.hiddenByDefault === true
      && result.workshop.labels.reforge === '重铸 260'
      && result.workshop.reforged.gold === 740
      && result.workshop.reforged.reforges === 1
      && result.workshop.reforged.affixCount === 1
      && result.workshop.reforged.changed === true
      // 重铸不碰耐久：两条独立出口（用户 2026-11-17 定）。
      && result.workshop.reforged.durability === 60
      && result.workshop.reforged.durabilityMax === undefined
      && result.workshop.reforged.btnDisabled === true
      && /已重铸/.test(result.workshop.reforged.btnLabel), result.workshop],
  ['工坊：修理回满耐久，但上限从 160 永久磨到 135',
    result.workshop.labels.repair === '修 240'
      && result.workshop.repaired.label === '修 240'
      && result.workshop.repaired.durability === 135
      && result.workshop.repaired.durabilityMax === 135
      && result.workshop.repaired.repairs === 1
      && result.workshop.repaired.gold === 500
      && result.workshop.repaired.rowGone === true, result.workshop],
  ['信息卡显示掷定伤害（不是区间）：实例值优先 / 无实例值取中值',
    /^伤害\d+$/.test(result.tip.dmgRolled || '')
      && result.tip.dmgRolled === '伤害271'
      && /^伤害\d+$/.test(result.tip.dmgLegacy || '')
      && result.tip.dmgLegacy === '伤害13', result.tip],
];

let failed = 0;
for (const [name, ok, actual] of checks) {
  console.log((ok ? '[ OK ] ' : '[FAIL] ') + name);
  if (!ok) { console.log('       actual: ' + JSON.stringify(actual)); failed += 1; }
}
console.log(`meta-ui browser acceptance: ${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exit(1);

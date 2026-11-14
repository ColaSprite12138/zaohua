/**
 * Inject the meta (out-of-run) UI into the ForgeAX build output, turning the
 * 4174 preview into ONE continuous page: prep -> battle -> settlement.
 *
 *   node scripts/inject-shell.mjs            # inject into dist/index.html (idempotent)
 *   node scripts/inject-shell.mjs --check   # fail if dist is stale / missing
 *
 * Also exports injectInto(html) / hasShellBlock(html) for
 * `scripts/package-with-shell.mjs`, which patches the packaged Web ZIP.
 * Importing this module never touches dist/.
 *
 * `dist/index.html` is a generated artifact and is wiped on every build, so
 * this script MUST run after `forgeax project build` (wired into verify.sh /
 * verify-all.sh). It never touches source files.
 *
 * The injected layer reuses the SAME authored sources as the standalone page:
 *   meta-ui/index.html      -> DOM + interaction script (MetaShell hook)
 *   meta-ui/voxel.js        -> generated voxel art (item models for every cell)
 *   meta-ui/inventory.js    -> generated rules (single source of truth)
 *   meta-ui/account.js      -> generated platform KV save logic
 *   meta-ui/platform-store.js -> platform identity + save bridge (shell only)
 *   meta-ui/shell.css       -> scoped shell chrome
 *   meta-ui/shell-bridge.js -> deploy / settlement / in-run bag over BroadcastChannel
 *   resource/generated/{item,weapon}.ts -> joined item catalog as JSON
 *
 * account.js / platform-store.js are intentionally NOT referenced by the
 * standalone file:// page: that page stays a double-clickable, serverless demo
 * with no login and no save. Only the injected shell has platform identity.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const distHtml = path.join(root, 'dist/index.html');
const BEGIN = '<!-- FORGEAX_META_SHELL_BEGIN -->';
const END = '<!-- FORGEAX_META_SHELL_END -->';

/** Parse the plain `export const item = [...] as const;` literal into JSON. */
function generatedRows(file, name) {
  const text = read(`assets/resource/generated/${file}`);
  const start = text.indexOf(`export const ${name} = [`);
  if (start < 0) throw new Error(`${file}: missing ${name}`);
  const open = text.indexOf('[', start);
  const close = text.indexOf('] as const', open);
  const json = `[${text.slice(open + 1, close)}]`
    .replace(/([{,]\s*)([a-z_][a-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(json);
}

/**
 * Scope the standalone page's global CSS under #fx-shell. Without this,
 * `body { background }`, `*` and bare `button` / `h1` rules would restyle the
 * ForgeAX canvas page. The authored CSS has no nested at-rules, so a flat
 * rule split is sufficient (and is asserted below).
 */
function scopeCss(css) {
  if (/@media|@supports|@keyframes|@container/i.test(css)) {
    throw new Error('meta-ui/index.html CSS gained an at-rule; update scopeCss()');
  }
  return css.replace(/([^{}]+)\{([^{}]*)\}/g, (_all, rawSelectors, body) => {
    const selectors = rawSelectors.trim();
    if (!selectors || selectors.startsWith('/*')) return '';
    const scoped = selectors.split(',').map((raw) => {
      const sel = raw.trim();
      if (sel === ':root' || sel === 'body' || sel === 'html') return '#fx-shell';
      if (sel === '*') return '#fx-shell *';
      return `#fx-shell ${sel}`;
    }).join(', ');
    return `${scoped} {${body}}`;
  });
}

/** Extract <style> blocks and the <body> inner markup from meta-ui/index.html. */
function extractMetaPage() {
  const html = read('meta-ui/index.html');
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/);
  if (!bodyMatch) throw new Error('meta-ui/index.html: no <body>');
  // The standalone page loads ./inventory.js and has one inline <script>.
  const scripts = [...bodyMatch[1].matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]);
  const markup = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/g, '').trim();
  if (scripts.length !== 1) throw new Error(`meta-ui/index.html: expected 1 inline script, got ${scripts.length}`);
  return { styles, markup, script: scripts[0] };
}

function buildBlock() {
  const { styles, markup, script } = extractMetaPage();
  // item.xlsx owns identity (name / item_type / stack_size); weapon.xlsx owns
  // combat attributes (quality / damage / weapon_subtype). Join by id before
  // handing rows to registerItemDefs(), so quality-based colours and damage
  // numbers do not silently disappear after the table split.
  const itemRows = generatedRows('item.ts', 'item');
  const weaponRows = generatedRows('weapon.ts', 'weapon');
  const weaponsById = new Map(weaponRows.map((r) => [String(r.id), r]));
  const rows = itemRows.map((r) => {
    const w = weaponsById.get(String(r.id));
    return {
      ...r,
      quality: w ? w.quality : '',
      damage_min: w ? w.damage_min : 0,
      damage_max: w ? w.damage_max : 0,
      weapon_subtype: w ? w.weapon_subtype : null,
    };
  });
  const sources = [
    'meta-ui/index.html', 'meta-ui/voxel.js', 'meta-ui/inventory.js',
    'meta-ui/account.js', 'meta-ui/platform-store.js', 'meta-ui/shell.css',
    'meta-ui/shell-bridge.js',
    'assets/resource/generated/item.ts',
    'assets/resource/generated/weapon.ts',
  ];
  const digest = createHash('sha256')
    .update(sources.map((f) => read(f)).join('\n---\n'))
    .digest('hex');

  return `${BEGIN}
<!-- GENERATED by scripts/inject-shell.mjs - DO NOT EDIT.
     sources sha256: ${digest}
     Rebuild with: forgeax project build && node scripts/inject-shell.mjs -->
<style id="fx-meta-styles">
${scopeCss(styles)}
${read('meta-ui/shell.css')}
</style>
<script>window.MetaShell = { authoredItems: ${JSON.stringify(rows)} };</script>
<div id="fx-shell">
${markup}
</div>
<script>${read('meta-ui/voxel.js')}</script>
<script>${read('meta-ui/inventory.js')}</script>
<script>${read('meta-ui/account.js')}</script>
<script>${script}</script>
<script>${read('meta-ui/platform-store.js')}</script>
<script>${read('meta-ui/shell-bridge.js')}</script>
${END}`;
}

/**
 * Insert or refresh the meta shell block in ANY ForgeAX-generated HTML.
 * The 4174 dist injector below and scripts/package-with-shell.mjs (which patches
 * the packaged Web ZIP) share this single implementation, so the two entry
 * points can never drift apart.
 */
export function injectInto(html) {
  const block = buildBlock();
  const start = html.indexOf(BEGIN);
  const end = html.indexOf(END);
  const hasBlock = start >= 0 && end > start;
  if (!hasBlock && !html.includes('</body>')) {
    throw new Error('meta shell: HTML has neither an existing block nor a </body> anchor');
  }
  return hasBlock
    ? html.slice(0, start) + block + html.slice(end + END.length)
    : html.replace('</body>', `${block}\n</body>`);
}

export function hasShellBlock(html) {
  const start = html.indexOf(BEGIN);
  const end = html.indexOf(END);
  return start >= 0 && end > start;
}

function main() {
  const check = process.argv.includes('--check');
  if (!existsSync(distHtml)) {
    console.error(`[FAIL] ${distHtml} missing; run forgeax project build first`);
    return 1;
  }
  const current = readFileSync(distHtml, 'utf8');
  const injected = injectInto(current);
  const hasBlock = hasShellBlock(current);

  if (check) {
    if (!hasBlock || current !== injected) {
      console.error('[FAIL] dist/index.html meta shell missing or stale; run node scripts/inject-shell.mjs');
      return 1;
    }
    console.log('[ OK ] dist/index.html meta shell is up to date');
    return 0;
  }

  if (hasBlock && current === injected) {
    console.log('[ OK ] already injected, no change');
    return 0;
  }
  writeFileSync(distHtml, injected, 'utf8');
  console.log(`[ OK ] injected meta shell into dist/index.html (${injected.length} bytes)`);
  return 0;
}

// Only mutate dist/ when invoked directly. Importing this module must be side-effect
// free: package-with-shell.mjs imports injectInto() to patch a ZIP, not dist/.
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) process.exitCode = main();

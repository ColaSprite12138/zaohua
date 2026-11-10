/**
 * Transpile the ONE authoritative meta logic file into a classic browser
 * script, so meta-ui/index.html works by double-clicking (file://), with no
 * server, no bundler and no CORS-restricted ES modules.
 *
 *   node scripts/build-meta-ui.mjs          # regenerate meta-ui/inventory.js
 *   node scripts/build-meta-ui.mjs --check  # fail if generated JS is stale
 *
 * The generated file is committed on purpose: the standalone page must open
 * without running a build first. `--check` is wired into the meta module's
 * incremental gate so the two can never drift.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'assets/meta/inventory.ts');
const outputPath = path.join(root, 'meta-ui/inventory.js');

const source = readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    strict: true,
    removeComments: false,
  },
  fileName: 'inventory.ts',
  reportDiagnostics: true,
});

const fatal = (transpiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
if (fatal.length > 0) {
  for (const d of fatal) console.error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  process.exit(1);
}

const banner = `/* GENERATED FILE — DO NOT EDIT.
 * Source of truth: assets/meta/inventory.ts
 * Regenerate: node scripts/build-meta-ui.mjs
 * Source SHA-256: ${(await import('node:crypto')).createHash('sha256').update(source).digest('hex')}
 */\n`;

const generated = `${banner}(function (root) {
"use strict";
var module = { exports: {} };
var exports = module.exports;
${transpiled.outputText}
root.MetaInventory = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
`;

if (process.argv.includes('--check')) {
  if (!existsSync(outputPath)) {
    console.error('[FAIL] meta-ui/inventory.js is missing; run node scripts/build-meta-ui.mjs');
    process.exit(1);
  }
  const current = readFileSync(outputPath, 'utf8');
  if (current !== generated) {
    console.error('[FAIL] meta-ui/inventory.js is stale vs assets/meta/inventory.ts; regenerate it.');
    process.exit(1);
  }
  console.log('[ OK ] meta-ui/inventory.js matches assets/meta/inventory.ts');
  process.exit(0);
}

writeFileSync(outputPath, generated, 'utf8');
console.log(`[ OK ] wrote ${path.relative(root, outputPath)} (${generated.length} bytes)`);

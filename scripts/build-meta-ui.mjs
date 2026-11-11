/**
 * Transpile the authoritative meta logic files into classic browser scripts,
 * so meta-ui/index.html works by double-clicking (file://), with no server, no
 * bundler and no CORS-restricted ES modules.
 *
 *   node scripts/build-meta-ui.mjs          # regenerate all meta-ui/*.js
 *   node scripts/build-meta-ui.mjs --check  # fail if any generated JS is stale
 *
 * The generated files are committed on purpose: the standalone page must open
 * without running a build first. `--check` is wired into the meta module's
 * incremental gate so source and generated JS can never drift.
 *
 * `account.js` is NOT referenced by the standalone page (that page stays a
 * serverless demo). scripts/inject-shell.mjs injects it into the 4174 shell,
 * where the platform KV save envelope and write queue live. There is NO local
 * adapter: outside the platform host the shell persists nothing.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  {
    source: 'assets/meta/inventory.ts',
    output: 'meta-ui/inventory.js',
    global: 'MetaInventory',
  },
  {
    source: 'assets/meta/account.ts',
    output: 'meta-ui/account.js',
    global: 'MetaAccount',
  },
];

function generatedFor(target) {
  const source = readFileSync(path.join(root, target.source), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      strict: true,
      removeComments: false,
    },
    fileName: path.basename(target.source),
    reportDiagnostics: true,
  });
  const fatal = (transpiled.diagnostics ?? [])
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (fatal.length > 0) {
    for (const d of fatal) {
      console.error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    }
    process.exit(1);
  }
  const digest = createHash('sha256').update(source).digest('hex');
  const banner = `/* GENERATED FILE — DO NOT EDIT.
 * Source of truth: ${target.source}
 * Regenerate: node scripts/build-meta-ui.mjs
 * Source SHA-256: ${digest}
 */\n`;
  return `${banner}(function (root) {
"use strict";
var module = { exports: {} };
var exports = module.exports;
${transpiled.outputText}
root.${target.global} = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);
`;
}

const check = process.argv.includes('--check');
let failed = false;
for (const target of targets) {
  const outputPath = path.join(root, target.output);
  const generated = generatedFor(target);
  if (check) {
    if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== generated) {
      console.error(`[FAIL] ${target.output} is missing or stale vs ${target.source}; regenerate it.`);
      failed = true;
    } else {
      console.log(`[ OK ] ${target.output} matches ${target.source}`);
    }
  } else {
    writeFileSync(outputPath, generated, 'utf8');
    console.log(`[ OK ] wrote ${target.output} (${generated.length} bytes)`);
  }
}
process.exitCode = failed ? 1 : 0;

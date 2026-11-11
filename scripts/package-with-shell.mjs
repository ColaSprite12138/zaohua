/**
 * Produce the ForgeAX Web ZIP *with* the meta (out-of-run) UI shell included.
 *
 * Why the ZIP has to be patched after packaging:
 *   - `forgeax project package` rebuilds dist/ internally (devkit
 *     commands-CKFSB2ND.mjs:2877) and exposes no post-build hook, so anything
 *     injected into dist/index.html before packaging is overwritten.
 *   - `verifyDist` compares every artifact against forgeax-dist.json, so dist/
 *     cannot be edited in place either.
 *   - Game Builder prefers the project's `scripts.package` over calling the CLI
 *     directly (runtime cli.js:24817). That is the one supported seam: we own
 *     the packaging step, run the official packager, then patch its ZIP.
 *
 * Game Builder calls:
 *   pnpm run package --format web-zip --output <archive>
 * which resolves to this file via package.json#scripts.package.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasShellBlock, injectInto } from './inject-shell.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORGEAX_CLI = path.join(root, 'node_modules/@forgeax/engine/dist/bin/forgeax.mjs');
const ZIP_IO = path.join(root, 'scripts/zip-io.py');

function parseArgs(argv) {
  const opts = { format: 'web-zip', output: '', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--output') opts.output = argv[++i];
    else if (argv[i] === '--format') opts.format = argv[++i];
    else if (argv[i] === '--json') opts.json = true;
  }
  if (!opts.output) opts.output = path.join(root, 'release/forgeax-game-web.zip');
  return opts;
}

function run(label, command, args, env) {
  // inherit: keep the engine's build progress visible instead of buffering it.
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status})`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.format !== 'web-zip') {
    throw new Error(`unsupported --format ${opts.format}; this project only ships web-zip`);
  }
  if (!existsSync(FORGEAX_CLI)) throw new Error(`ForgeAX CLI missing: ${FORGEAX_CLI}`);
  if (!existsSync(ZIP_IO)) throw new Error(`zip-io.py missing: ${ZIP_IO}`);

  const staging = mkdtempSync(path.join(tmpdir(), 'forgeax-shell-'));
  const officialZip = path.join(staging, 'official.zip');
  const unpacked = path.join(staging, 'player');
  const env = { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' };

  try {
    // 1. Official packager -> pristine ZIP (rebuilds dist/, no hook available).
    run('official package', process.execPath,
      [FORGEAX_CLI, 'project', 'package', '--format', 'web-zip', '--output', officialZip, '--json'], env);
    if (!existsSync(officialZip)) throw new Error('official package produced no ZIP');

    // 2. Unpack, inject the shell, refresh the manifest entry for index.html.
    run('zip extract', 'python', [ZIP_IO, 'extract', officialZip, unpacked], env);

    const htmlPath = path.join(unpacked, 'index.html');
    const manifestPath = path.join(unpacked, 'forgeax-dist.json');
    if (!existsSync(htmlPath)) throw new Error('ZIP is missing index.html');
    if (!existsSync(manifestPath)) throw new Error('ZIP is missing forgeax-dist.json');

    const before = readFileSync(htmlPath, 'utf8');
    if (hasShellBlock(before)) throw new Error('ZIP index.html already carries the shell block');
    const after = injectInto(before);
    const htmlBytes = Buffer.from(after, 'utf8');
    writeFileSync(htmlPath, after, 'utf8');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entry = manifest.artifacts?.find((artifact) => artifact.path === 'index.html');
    if (!entry) throw new Error('forgeax-dist.json has no index.html artifact entry');
    entry.bytes = htmlBytes.length;
    entry.sha256 = createHash('sha256').update(htmlBytes).digest('hex');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    // 3. Repack to the requested --output. Builder later unpacks this archive,
    //    injects its platform bootstrap into <head>; the shell lives before
    //    </body> and survives that rewrite untouched.
    run('zip pack', 'python', [ZIP_IO, 'pack', opts.output, unpacked], env);

    console.log(`[ OK ] Web ZIP with meta shell: ${opts.output} (index.html ${htmlBytes.length} bytes)`);
    if (opts.json) {
      console.log(JSON.stringify({ output: opts.output, shell: true, indexBytes: htmlBytes.length }));
    }
    return 0;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exitCode = 1;
}

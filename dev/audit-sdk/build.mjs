// Bundles the plugin's command line, the Google Gen AI SDK with it, into plugins/audit-auto/server/dist/audit.mjs, the one file the
// plugin runs. The plugin is installed by copying its folder, so everything it needs at run time has to be in this file.
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.resolve(here, '../../plugins/audit-auto/server/dist');

// Parts of the SDK's dependencies (google-auth-library, protobufjs, ws) are CommonJS and expect require, __filename and __dirname.
const shims = [
  "import { createRequire as __createRequire } from 'node:module';",
  "import { fileURLToPath as __fileURLToPath } from 'node:url';",
  "import { dirname as __dirnameOf } from 'node:path';",
  'const require = __createRequire(import.meta.url);',
  'const __filename = __fileURLToPath(import.meta.url);',
  'const __dirname = __dirnameOf(__filename);',
].join('\n');

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: { audit: path.join(here, 'src/audit.ts') },
  outdir, outExtension: { '.js': '.mjs' }, entryNames: '[name]',
  bundle: true, format: 'esm', platform: 'node', target: 'node24',
  legalComments: 'none', sourcemap: false, minify: true, logLevel: 'info',
  banner: { js: shims },
  // Optional native accelerators of `ws`; it falls back to plain JavaScript without them.
  external: ['bufferutil', 'utf-8-validate'],
});

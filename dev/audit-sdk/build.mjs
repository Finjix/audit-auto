// Bundles the plugin's command line into plugins/audit-auto/server/dist/audit.mjs, the one file the
// plugin runs. The plugin is installed by copying its folder, so everything it needs at run time has to be in this file.
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.resolve(here, '../../plugins/audit-auto/server/dist');

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: { audit: path.join(here, 'src/audit.ts') },
  outdir, outExtension: { '.js': '.mjs' }, entryNames: '[name]',
  bundle: true, format: 'esm', platform: 'node', target: 'node24',
  legalComments: 'none', sourcemap: false, minify: true, logLevel: 'info',
});

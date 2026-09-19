// Bundles story-how-scenes.ts into one module so it can be checked with plain
// node and no Angular. Runs before the scene tests.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sources = [
  [join(here, '..', '..', 'src', 'app', 'public', 'main-page', 'story', 'story-how-scenes.ts'), join(here, 'scenes.mjs')],
  // The priority fee calculation: pure arithmetic, checked without a browser.
  [join(here, '..', '..', 'src', 'app', 'pool', 'priority-fee.ts'), join(here, 'fee.mjs')],
];

for (const [source, out] of sources) {
  execFileSync('npx', ['esbuild', source, '--bundle', '--format=esm', `--outfile=${out}`, '--log-level=warning'], {
    stdio: 'inherit',
    cwd: join(here, '..', '..')
  });
}

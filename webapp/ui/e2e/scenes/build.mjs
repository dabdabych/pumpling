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
  // What the pool page says about a round: also pure, and the one place where
  // the buyer's second pass turns into words and a countdown.
  [join(here, '..', '..', 'src', 'app', 'pool', 'pool-view.ts'), join(here, 'pool-view.mjs')],
  // The burn: the choice and its memo, token amounts, the feed's three kinds of
  // row, and the verification window's burn section. All pure.
  [join(here, '..', '..', 'src', 'app', 'pool', 'burn.ts'), join(here, 'burn.mjs')],
  [join(here, '..', '..', 'src', 'app', 'pool', 'token-amount.ts'), join(here, 'token-amount.mjs')],
  [join(here, '..', '..', 'src', 'app', 'pool', 'feed-rows.ts'), join(here, 'feed-rows.mjs')],
  [join(here, '..', '..', 'src', 'app', 'shared', 'verify-round', 'burn-view.ts'), join(here, 'burn-view.mjs')],
];

for (const [source, out] of sources) {
  execFileSync('npx', ['esbuild', source, '--bundle', '--format=esm', `--outfile=${out}`, '--log-level=warning'], {
    stdio: 'inherit',
    cwd: join(here, '..', '..')
  });
}

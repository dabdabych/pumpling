// Running every browser check suite.
//
// Every suite is its own process: one failing does not take the rest down, and
// the exit code honestly shows what broke. They run one at a time because they
// measure time (poll rate, animation smoothness) and would interfere.
//
//   npm run e2e                     every suite
//   npm run e2e -- how-anim price   only the ones matching by name
//   BASE=http://localhost:4200 npm run e2e
//   SHOTS=1 npm run e2e             save screenshots into e2e/shots
//
// It needs a running frontend on BASE (http://localhost:3200 by default).

import { spawn } from 'node:child_process';
import { readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suitesDir = join(here, 'suites');
const BASE = process.env.BASE || 'http://localhost:3200';

// The slow suites go last: fast feedback matters more than order.
const SLOW = new Set(['poll-rate.mjs']);

const filters = process.argv.slice(2);
const all = readdirSync(suitesDir).filter((name) => name.endsWith('.mjs')).sort();
const chosen = all
  .filter((name) => filters.length === 0 || filters.some((filter) => name.includes(filter)))
  .sort((a, b) => Number(SLOW.has(a)) - Number(SLOW.has(b)));

if (chosen.length === 0) {
  console.error(`Nothing matched ${filters.join(', ')}. Available: ${all.map((n) => n.replace('.mjs', '')).join(', ')}`);
  process.exit(2);
}

const env = { ...process.env, BASE };
if (process.env.SHOTS) {
  const shots = join(here, 'shots');
  mkdirSync(join(shots, 'pw', 'shots'), { recursive: true });
  // The suites put images into $S/pw/shots — we keep that path.
  env.S = shots;
}

async function check(url, attempts = 5) {
  // The dev server may have just started rebuilding: we let it finish instead of
  // declaring the frontend dead on the first attempt.
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        return true;
      }
    } catch {
      // wait quietly for the next attempt
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  return false;
}

if (!(await check(BASE))) {
  console.error(`The frontend is not answering on ${BASE}. Start it: npm start`);
  process.exit(2);
}

const run = (name) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(suitesDir, name)], { env, stdio: 'inherit' });
    child.on('close', (code) => resolve({ name, code: code ?? 1, seconds: (Date.now() - started) / 1000 }));
  });

const results = [];
for (const name of chosen) {
  console.log(`\n=== ${name.replace('.mjs', '')}`);
  results.push(await run(name));
}

console.log('\n================ SUMMARY ================');
for (const { name, code, seconds } of results) {
  console.log(`${code === 0 ? 'ok  ' : 'FAIL'} ${name.replace('.mjs', '').padEnd(16)} ${seconds.toFixed(1)}s`);
}
const failed = results.filter((result) => result.code !== 0);
console.log(failed.length ? `\n${failed.length} of ${results.length} suites failed` : `\nall ${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);

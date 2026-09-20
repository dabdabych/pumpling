// The account lists the admin area hands to the program.
//
// The admin page builds two instructions by hand and asks the wallet to sign
// them. Nothing between here and the chain checks that the accounts it names
// are the ones the program expects: Anchor's `.accounts({...})` is loosely
// typed, so a leftover name from an older version compiles, builds, ships, and
// then fails on the one click that matters.
//
// That is not hypothetical. After the move to ORAO both calls still passed
// `randomnessAccountData`, an account the program no longer has, and the
// production build was perfectly happy.
//
// So this reads the three things that have to agree — the IDL, the component,
// and the shape the server promises — and checks they say the same thing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const repo = join(root, '..', '..');

const idl = JSON.parse(readFileSync(join(root, 'src/app/idl/lottery_v_1_0.json'), 'utf8'));
const component = readFileSync(
  join(root, 'src/app/admin/lottery-details/lottery-details.component.ts'), 'utf8'
);
const schemas = readFileSync(join(repo, 'webapp/backend/application/lottery/schemas.py'), 'utf8');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** The accounts the IDL says an instruction takes, in camelCase. */
function idlAccounts(name) {
  const ix = idl.instructions.find((i) => i.name === name);
  assert.ok(ix, `the IDL has no instruction ${name}`);
  return new Set(ix.accounts.map((a) => camel(a.name)));
}

/** The accounts the component passes to `.accounts({...})` for a call. */
function componentAccounts(methodCall) {
  const at = component.indexOf(methodCall);
  assert.ok(at > 0, `the component does not call ${methodCall}`);
  const from = component.indexOf('.accounts({', at);
  assert.ok(from > 0, `no .accounts({...}) after ${methodCall}`);
  const to = component.indexOf('})', from);
  const body = component.slice(from + '.accounts({'.length, to);
  return new Set(
    body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('//'))
      .map((line) => line.split(':')[0].trim())
      .filter(Boolean)
  );
}

t('start_second_phase is given exactly the accounts the program asks for', () => {
  const expected = idlAccounts('start_second_phase');
  const actual = componentAccounts('.startSecondPhase(');
  assert.deepEqual([...actual].sort(), [...expected].sort());
});

t('fulfill_randomness is given exactly the accounts the program asks for', () => {
  const expected = idlAccounts('fulfill_randomness');
  const actual = componentAccounts('.fulfillRandomness(');
  assert.deepEqual([...actual].sort(), [...expected].sort());
});

t('no Switchboard account survives in the admin area', () => {
  // The name the old oracle used. If it comes back, something was copied from
  // an old branch.
  assert.ok(!component.includes('randomnessAccountData'), 'randomnessAccountData is back');
});

t('the server promises every field the page reads off it', () => {
  // Phase2AccountsResponse is what /phase2-accounts returns. The page reads
  // `prepared.<field>`; each one has to be in that model or it arrives
  // undefined and the transaction is built with holes.
  const model = schemas.slice(schemas.indexOf('class Phase2AccountsResponse'));
  const fields = new Set(
    model
      .slice(0, model.indexOf('\n\n\n'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[a-z_]+\s*:/.test(line))
      .map((line) => line.split(':')[0].trim())
  );
  const read = new Set([...component.matchAll(/prepared\.([a-z_]+)/g)].map((m) => m[1]));
  assert.ok(read.size > 0, 'the page reads nothing off the server response');
  for (const field of read) {
    assert.ok(fields.has(field), `the page reads prepared.${field}, the server does not promise it`);
  }
});

t('the seed slot is passed as a number the program can take', () => {
  // The instruction takes (weights_hash, seed_slot). A plain JS number loses
  // precision above 2^53, and a slot will get there; it has to go as a BN.
  const at = component.indexOf('.startSecondPhase(');
  const args = component.slice(at, component.indexOf('.accounts({', at));
  assert.ok(args.includes('new BN(prepared.seed_slot)'), `slot not passed as BN: ${args.trim()}`);
  assert.ok(args.includes('prepared.weights_hash'), 'the commitment does not come from the server');
});

console.log(`\n${n} tests passed`);

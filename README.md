<p align="center">
  <img src="webapp/ui/src/assets/images/pumpling-mascot.png" alt="Pumpling" width="120">
</p>

<h1 align="center">Pumpling</h1>

<p align="center"><b>Attention you can buy, with a receipt on Solana.</b></p>

<p align="center">
  <a href="https://pumpling.xyz">pumpling.xyz</a> ·
  <a href="https://x.com/pumplingxyz">@pumplingxyz</a> ·
  <a href="https://solscan.io/account/4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH">program</a>
</p>

---

This is our repository for the Colosseum Crypto World's Fair. Everything we
built is here: the Anchor program, the site, the API, the round workers, the
off-chain buyer and the tools we use to run and check a round.

## What Pumpling is

A new coin usually fails for one reason. Nobody hears about it. Hype is gated by
follower count, and a team without an audience cannot buy its way in. Buying
your own coin for 100 SOL creates no hype either, because nobody sees it coming
and nobody expects it to continue.

Pumpling makes attention purchasable. Anyone can name a Solana memecoin and put
SOL behind it. While the pool is open, everyone sees which coins are in and how
much SOL stands behind each one. When the pool closes, that SOL goes into public
on-chain buys of those coins, and the tokens bought reach the wallets that
backed them.

What people buy here is not the payout. It is the public promise to buy,
published before the buying starts. The promise is believable because it lives
on-chain and nobody can pull the SOL back out.

## How a round works

| Phase | Length | What happens |
|---|---|---|
| Open | up to ~2 hours, or until the 111 SOL cap | anyone adds SOL behind any Solana memecoin |
| Draw | a few seconds | verifiable randomness from ORAO VRF sets each coin's share of the buying |
| Buys | about an hour | the SOL goes out in small on-chain purchases |
| Done | five minutes | bought tokens reach the wallets that backed those coins, then the next pool opens |

Four things we say out loud, because they are easy to get wrong:

* **The draw can zero a coin.** Shares are weighted by the SOL behind a coin,
  but the outcome is random. Small stakes swing the most, sometimes down to
  nothing. The site says this next to the commit button, not in a footnote.
* **Buying happens off-chain on purpose.** The program releases the pool to a
  keeper wallet, and the buyer spends it in small batches across the hour.
  Every purchase is a normal transaction with a signature anyone can open. The
  buy being public is deliberate; only its schedule is not, and the next
  section says why.
* **Unspent SOL goes back.** If purchases cannot go through, the remainder
  returns to the people who put it in, split by their share, with the network
  fee taken out.
* **Fee: 3% of the pool.** Today that is our only revenue.

## "So traders will just front-run you"

They will, and that is the product.

The pool is announced on chain before a single coin is bought. Anyone can see
that N SOL is about to be spent on a named list of coins, and act on it. We
want them to. What a launcher is paying for is the crowd that turns up in
anticipation. Our own buying is small and was never the point; the attention
is, and it exists only because the buy cannot be faked and cannot be called
off.

That is also the honest difference from paying an influencer. Both are ways to
buy attention. Only one of them leaves a receipt.

What the design does not want is a machine that can compute the payoff exactly
and take it without adding anything. Two things are in the way, and both are in
this repository:

**The split between coins is decided after the commitment is fixed.** The
weights go on chain when the round closes; ORAO then produces the randomness
that sets each coin's share. The number of draws is capped on purpose
(`K_MAX = 70` in `vrf_engine.py`): more draws would pull every coin closer to
its exact proportion, and with fifteen coins in a round the cap leaves a spread
of about 16%. Nobody can work out what a single coin will get, however much
compute they point at it, because the number does not exist yet.

**The schedule is not published.** The buyer splits the window into slots,
picks a random moment inside each one, keeps a minimum gap, and varies each
amount by ±10%. You can know the hour. You cannot know the minute or the size.

Where that stops: the pool total is public, so the aggregate pressure is known,
and a round with a single coin has nothing to split, leaving only the timing
uncertain. We would rather write that down than let someone find it and think
it was hidden.

## The program on mainnet

```
4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH
```

It is a verified build. Rebuild this repository in the pinned container and the
hash matches the bytes running on chain, which anyone can check without asking
us:

```bash
solana-verify verify-from-repo https://github.com/dabdabych/pumpling \
  --program-id 4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH \
  --library-name lottery_v_1_0 --mount-path contracts \
  -b solanafoundation/solana-verifiable-build:2.3.11
```

The deployed binary also carries a `security.txt`, so the contact for a
vulnerability is readable off the program itself rather than off a page we
control.

## Checking a round yourself

Nothing here asks for trust. Every round publishes what it stands on:

```
GET https://pumpling.xyz/api/lottery/<round id>/verification
```

You get four things and can check each one on your own:

1. **The commitment.** Before the draw, the program stores a hash of who put how
   much behind which coin. The response carries the exact text that was hashed.
   Run sha256 on it and compare. The rule for building that text lives in one
   file, `webapp/backend/shared/weights_commitment.py`, which both the worker
   that writes the hash and the endpoint that serves the preimage import.
2. **The randomness.** The seed and the account it came from. If a round was
   ever drawn with an operator seed because the oracle did not answer, the
   response says so, and so does the site.
3. **The algorithm.** Each round stores the fingerprint of the code that turns
   the seed into shares. The code is
   `webapp/backend/application/lottery/vrf_engine.py` and
   `scripts/vrf_algorithm_hash.py` prints its hash.
4. **The result.** Shares per coin, and every purchase with its signature.

The site has the same thing behind a "Verify this pool" button, on the pool page
and on every past round in the archive.

### One file that cannot be edited quietly

The fingerprint in point 3 is the sha256 of `vrf_engine.py` **as a whole file,
comments included**. So editing a comment in it moves the commitment exactly as
much as editing the formula does, and every round created after the edit carries
the new value while older ones keep the old one.

That is why the value is not written by hand anywhere.
`scripts/vrf_algorithm_hash.py` derives it from the source, `--check` exits
non-zero when what is committed has drifted, `--write` updates all five places
that carry it, and a backend test fails the run if they disagree. A stale
commitment cannot reach mainnet.

## What is in this repository

| Folder | Stack | Role |
|---|---|---|
| `contracts/` | Rust, Anchor | the on-chain program `lottery_v_1_0` |
| `webapp/ui/` | Angular | the site: main page, pool page, personal history, archive |
| `webapp/backend/` | Python, FastAPI | API, accounts, commits, coin checks, round state |
| `workers/` | Python, asyncio | round lifecycle, on-chain events, backfill |
| `offchain/` | TypeScript | the buyer: batched purchases, delivery, refunds |
| `infra/` | Loki, Grafana | dashboards and alert rules |

Each folder has its own `CLAUDE.md` with the decisions behind it: what the
component does, why it is built that way, and what is deliberately not done yet.
Those files are the honest version of this README — they name the bugs we
shipped and what they cost.

## Running it

```bash
./deploy.sh              # docker compose: postgres, api, ui, workers, buyer, vrf
./deploy.sh .env.dev     # same stack with a different set of secrets
```

Locally you usually want a part of the stack:

```bash
docker compose up -d postgres backend ui
docker compose up -d loki grafana      # monitoring on :3001
```

Secrets live in `.env` files and never in this repository; `.env.example` lists
every variable. The lifecycle worker needs an admin signer, the buyer needs a
keeper key. Both are described in `workers/CLAUDE.md` and `offchain/CLAUDE.md`.

[`DEVNET.md`](DEVNET.md) is the write-up of a full round driven end to end,
including the awkward parts: refunds for coins that could not be bought, and the
buyer picking itself back up after a crash mid-round.

## Tests

```bash
cd webapp/backend && python3 -m pytest   # API guards, rate limits, round state
npx jest                                 # buyer: purchases, delivery, refunds, recovery
cd webapp/ui && npm run test:scenes      # the maths behind the landing animations and fees
cd webapp/ui && npm start                # then, in another shell:
cd webapp/ui && npm run e2e              # browser suites against a real Chrome
```

The browser suites cover what unit tests cannot reach: animations, the commit
flow on a phone, wallet connection and switching, how often the page polls the
server, and whether a participant can find their own money in the table.

The rule for those suites is that a new one has to fail on the code as it was
before the fix. A test that passes either way proves nothing, and we have
shipped one of those before.

## A note on naming

Files, tables, routes and the deployed program use the word `lottery` for a
round. It is a meme name from the first prototype that stuck, and it is pinned
in place by the on-chain program `lottery_v_1_0` and the production database, so
it stays. The product is a promotion pool, and that is the language the site and
the docs use.

## Status

The program is deployed on mainnet and verified. Backend, workers, the draw,
the buyer and the frontend are written and exercised end to end: a full round,
from the first commit to the tokens landing in wallets, with the draw checked
against the chain independently of our own code.

What is ahead: the first public rounds, and the teams to run them for.

## License

The code is here to be read and checked. All rights reserved.

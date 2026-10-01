# CLAUDE.md — Frontend (Angular)

The Angular SPA. Two zones: the public site and the admin area. There is no
user dashboard any more: rounds are created and driven by
`lottery_phase_worker`, admins come from `LOTTERY_ADMIN_PUBKEYS`, and manual
control lives in the admin area. Talks to `webapp/backend` (FastAPI).

## Layout (src/app/)

```
public/        # the public site: main page, how it works, sign in
pool/          # the pool page: coin table, commit dialog, purchase feed
archive/       # past rounds
me/            # a participant's own commits and history
chat/          # chat for signed-in users
admin/         # manual control over a round
auth/          # sign in and session
shared/        # shared services and components: wallet, verify-round,
               #   blocked-bet-mints, error.interceptor
api-client/    # generated client for the backend API
store/         # state management
idl/           # the Anchor IDL (lottery_v_1_0.json) — types of the on-chain program
helpers/       # utilities
```

Root: `app.module.ts`, `app-routing.module.ts`, `app.component.ts`,
`token.interceptor.ts` (puts the JWT into headers).

## Environments

`src/environments/environment.ts` (dev) and `environment.prod.ts` (prod) hold
the backend base URL, the RPC and so on. The production build swaps the file.
Anything that has to change without a rebuild is read at runtime from
`/environment.json`, which nginx renders from container environment variables
(see `nginx.conf` and the `ui` service in `docker-compose.yml`).

## Running

```bash
npm install && npm start          # ng serve, locally
docker compose up -d ui           # production (service ui, image lottery-ui)
```

## Tests

```bash
npm run test:scenes               # the maths behind the landing animations and the fee picker
npm start                         # then, in another shell:
npm run e2e                       # browser suites against a real Chrome
```

`e2e/` drives a real browser through `playwright-core` and the system Chrome.
The suites cover what a unit test cannot reach: animations and scroll, the
commit flow on a phone, wallet connection and switching, how often the page
polls the server, the archive, and whether a participant can find their own
money in the table. `e2e/README.md` explains how to run one suite and how to
add another.

Rule for this folder: a new suite has to fail on the code as it was before the
fix. A test that passes either way proves nothing.

## The wallet never opens on a transaction that fails

A wallet simulates what it is asked to sign and shows a failed simulation as
a red warning ("This transaction reverted during simulation", "This dApp could
be malicious"). On a site asking for SOL that ends the visit. So
`CommitService.preflight` runs the exact commit on our node first, unsigned,
with `sigVerify: false`, which is Phantom's own advice in "Domain and
transaction warnings". If the program would refuse it (pool closed, paused,
cap, too little SOL, below rent), the wallet stays closed and the dialog says
why in words. If the node cannot answer, the wallet stays closed too.

A commit signed after the pool's `end_ts` is not a wallet warning: our own
`sendRawTransaction` runs the preflight, the node refuses it before it is
broadcast, no fee is taken, and the dialog says the pool no longer takes SOL.

What this cannot fix: a wallet set to another network than the site. The
stand runs on devnet, so a wallet left on mainnet simulates against accounts
that do not exist there and warns (`AccountNotInitialized`, 3012). Test the
stand with the wallet on devnet. The suite is `commit-preflight`, and every
suite that commits answers the check through `commitCheck` in
`e2e/lib/pool-mock.mjs`.

## A wallet that goes quiet

A wallet can take a signature request and answer nothing: no window, no
error. On 2026-09-30 Phantom did that on the stand, the dialog sat on "Confirm
in your wallet…" for good, and only reloading the page helped. Two guards:

- For Phantom only, `WalletService.confirmPhantomSession` checks the
  connection with Phantom itself before the signature,
  `connect({ onlyIfTrusted: true })`, which by Phantom's documentation never
  opens a window. No answer in 5 seconds and the dialog says Phantom is not
  responding instead of asking it to sign. Other wallets are asked nothing
  new: `onlyIfTrusted` is Phantom's flag and some wallets open a window for it.
- Ten seconds after any wallet is asked for a window
  (`WALLET_WINDOW_HINT_MS`), the dialog says the window has not opened and
  what to do, and the button offers a fresh try. The old request stays open:
  approved late, the commit goes through. Replaced by a fresh try, its
  signature is dropped and never broadcast (`CommitRequest.isCurrent`), so one
  click is still one commit. Error -32002 (a request already open) has its own
  words. The texts are pure functions in `pool/commit.service.ts`.

The suite is `wallet-silent`.

## Hover on a touch screen

Tailwind 4 puts `hover:` and `group-hover:` under `@media (hover: hover)`, and
our own hover rules sit under the same query so a tap cannot leave them stuck.
On a phone a hover effect therefore does not exist at all: anything shown only
on hover needs a finger version, or a phone never sees it. Quick start has one
in `public/main-page/quick-start-pointer.ts`: once the list is on screen and the
page has come to rest (in the pinned story, once Quick start is the step on
show), the rows show their hover looks in turn, 01 to 05, a few seconds each,
one at a time. The look is a `qres-quick-play` class styled next to each hover
rule. Do not trigger such things row by row as they cross the screen: a real
swipe carries the page on with its momentum, and they go off as it flies past,
several at once and out of order. Check them with touch gestures
(`Input.synthesizeScrollGesture`), not `scrollTo`, which has no momentum. The
suite is `quick-touch`.

## The burn

A participant can have part of what is bought for them burned instead of
delivered. In the commit dialog it is a row of four cards (0 / 25 / 50 / 100%)
under the amount, offered only when `/check-mint` says `can_burn`. The choice
goes into the commit transaction as a memo the wallet signs
(`burnMemoInstruction` in `pool/commit.service.ts`, text from `pool/burn.ts`);
0% sends no memo. The backend reads it back from the chain, never from a
request. The words around the choice, the coin chip, token amounts, the feed's
rows and the verification window's burn section are all pure modules
(`pool/burn.ts`, `pool/token-amount.ts`, `pool/feed-rows.ts`,
`shared/verify-round/burn-view.ts`) checked by `e2e/scenes/burn.test.mjs`,
which also checks that the memo the site signs is exactly the text the backend
parses (`webapp/backend/tests/fixtures/burn_memo_logs.json`). The flame is one
component, `shared/flame`. The browser suites are `burn-dialog` (including the
memo in the signed transaction), `burn-feed` and `burn-verify`.

Hover styles go under `@media (hover: hover)` and skip the chosen option: on a
phone a tap leaves `:hover` on, and the old priority rule outranked `.is-active`
and left the chosen level pale with white text on it.

`api-client/` is generated: `npm run gen:api` against a running backend, or
point `openapi-gen.json`'s `input` at `app.openapi()` dumped to a file.

NB: `idl/` must match the on-chain program and the backend. When the IDL
changes, update `workers/idl/` in the same commit.

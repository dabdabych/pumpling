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

## Red flags on a coin

A mark after the ticker in the pool table and in the commit dialog,
`shared/coin-screening/coin-screening-badge.component`: a black tick on a white
square, the same on every coin that has an answer, nothing at all on one that
has none. The row carries no verdict, and the card no count of flags: a red
mark, and then a "1 RED FLAG" in the card, scared people off a coin its
launcher pays to promote (Georgiy, 2026-10-02). The card shows what was read
the way pump.fun shows its numbers: dev, bundlers, bundled at launch, top 10
and insiders as ranges (`under 5%`, `5–20%`), the mint's powers, the flags as
red lines, then when it was checked and by whom, with a link to tracced or
Solana Tracker. It never sums the coin up in words. The first card put "No red
flags" over a sentence about the coin, which read as if we vouched for it, and
on Krackpot, still on its curve, it said the liquidity was in place, which
nobody can pull from a curve anyway: liquidity has a line only when it was
pulled.

The card is `shared/info-popover`, which the burn chip uses too. It comes up on
a mouse resting on the trigger, a tap, or Enter (the focus then goes into it);
it lives in the CDK overlay, keeps 16px off the screen's edges and never covers
its trigger. Its place across is worked out by the component: the overlay's own
push ignores a position's offset and moved the card off a 320px screen. A
trigger's finger target is bigger than what is drawn (`--popover-hit-x/y`): the
20px mark on every side, the wide burn chip only above and below, so the two
side by side never take each other's taps. The words are pure in
`coin-screening.ts`, and the backend's test checks that every reason code has
its line there. They never say safe, scam or verified.

On a phone the coin row puts the address chip on a line of its own (below
560px) and a long ticker ends in an ellipsis: beside the chip the coin's column
was 40px wide at 320px, and the ticker, the burn mark and the chip lay on top
of each other. The suite is `coin-screening`.

## The Commit SOL card

The left card on the first screen, `public/main-page/pool-cta`: Gleb's coins
and candles fill the card, and the whole card is one link to the pool page.
Over the drawing, in the clear band it leaves between the coins, two lines as
he drew them: what pressing the card does, and where the round is ("Pool open
· closes in 01:12:36", with a live dot). The title changes with the phase, so
pressing the card always does what it says: "Promote your coin" while a pool
takes SOL (it said "Commit SOL" until 2026-10-16, the mechanism rather than
what a visitor comes for), "Watch the draw", "Watch the buys", "See how it
ended" for the pool that has just ended (`/archive?pool=<id>`, which opens that
round), "See the pool" otherwise. The card opens the pool page and nothing
more: it opened the commit dialog at once (`/pool?commit=1`) for a day, and
Georgiy asked for that to go; the pool page's own Commit SOL opens it. The
words are the pure `pool-cta.ts`, checked by `e2e/scenes/pool-cta.test.mjs`.
It never shows a count that is zero.

History, so it is not tried again. On 2026-10-05 the card became a panel of
steps, a coin field, a button, the last buy and See past pools, laid over the
drawing; on 2026-10-16 Georgiy called that a nightmare: the drawing is the
card's signal to press it (preview decision of 2026-09-16). A third line under
the two was tried the same day and measured against the coins: the band holds
two lines and no more anywhere from 320px to 2560px.

The link is made the way Inclusive Components recommends for cards: the title
is the `<a>`, and its `::after` is stretched over the card, so the whole drawing
takes the press while a screen reader hears only the action, not the clock.
The card is its own stacking context with the drawing at `z-index: -1`, and
the words are not positioned, so the `::after` is positioned against the card.
A halo in the card's fill colour under the words keeps them readable where a
candle passes behind (NN/g, "Text Over Images").

A short card (a short window, or any desktop with reduced motion, where the
first screen is not pinned and the card is 220px) left no band at all: the
coins have a floor size, and at 4.2rem they stopped shrinking under ~280px of
card. The floor is 3rem now (`dex-card-animation.component.scss`), and on a
card of about 270px and less a size container tightens the two lines, never
making them larger than the ordinary size (the first version did, on phones).
The narrowest cards (phones of 320 to 360px) take the title a little smaller
still. A size container is safe here, unlike on content-driven boxes: the
card's host is absolutely positioned over the card, so its height never comes
from inside.

The suite is `pool-cta`. It measures each line's text against each coin's disc
(a third of the coin picture's shorter side: the SVGs are mostly margin) at
four moments of the coins' wobble, at every window, with and without motion.

The commit dialog checks a coin only for an account (`check-mint` answers 401
signed out). A 401 comes back as `SignInRequiredError`: signed out, the field
says "Sign in to check this coin. It stays here." with a Sign in button, and
the coin is checked as soon as the sign-in is done.

Funnel events go to GA4 through `shared/analytics` (production domains only):
`home_promote_click`, `home_watch_click`, `home_bubble_click`,
`coin_story_trade_click`,
`header_how_click`, `how_promote_click`, `past_pools_click` (header, header
menu, or pool page),
`chat_open`, `commit_dialog_open` and `commit_sent` (from the pool page),
`archive_round_open` (click or link). No wallet, address or amount in them.

## The coins in the pools (bubbles)

The right card on the first screen, `public/main-page/coin-bubbles`, since
2026-10-16 (the chat stood there; it is in the header now). The ten coins
committed to most lately with at least 1 SOL behind each, all pools together
(`?limit=10&sort=recent`), as bubbles: the biggest twice the smallest across
and no more, the ones between by the square root of their SOL, so size still
follows the SOL. The first version had the area in proportion to the SOL
(data-to-viz.com "Scaling to radius or area?"), and a 20 SOL coin dwarfed the
rest; Georgiy asked for two to one. A card too short for two to one at a
readable size gets a little less rather than losing a coin. Each is a button
that opens the coin's window (below); until 2026-10-16 it was a link to where
the coin trades, which is the window's first button now. Hover or focus says
what it is in the line under the bubbles, where a tooltip could only fall off
the card; the button's name says the same to a screen reader. A picture that
fails turns into initials. The list is biggest first, so Tab and a screen
reader meet them in the order the eye does.

Positions are the pure `bubble-layout.ts` (scene test
`bubble-layout.test.mjs`): biggest first, each next one in the free spot
touching a placed one nearest the middle, the group free to lean and centred
at the end, the largest scale that fits found by halving, the smallest coins
left out ("+N more") when even the smallest scale cannot hold them all.
Deterministic, so nothing jumps on a refresh; recomputed when the card resizes.
Labels sit inside their bubble: hanging out, a small bubble's ticker lay on
its neighbour. The suite is `coin-bubbles`.

## A coin's window

`public/main-page/coin-bubbles/coin-story-dialog`, opened from a bubble, since
2026-10-16: what pumpling did to that coin, to see. The coin's ticker, name,
picture and mint (Copy mint copies it whole), when it took part and in which
pool, the SOL behind it, what the pool bought of it, and its price chart over
its stay with the pool's buys marked under the candles they fell in, a dot on
the candle it came in on. The ways on are Trade on pump.fun (or DexScreener,
as the bubble was) and See pool #, the round in the archive.

Which stay, and the chart, are the server's (`/lottery/coins/<mint>/story`,
see the backend's "A coin's window"): for a coin in several pools, the one
where the most SOL stood behind it. The candles are GeckoTerminal's, in SOL,
fetched by the server on a schedule and kept, never on a visitor's request;
their attribution guide asks for "Source: GeckoTerminal" next to the data,
which is the line under the chart. A chart still being refreshed (its pool
runs) says "updated 3 min ago" there; a final one says nothing more. A coin
just in has no chart yet (`pending`): the window says it is on its way and
asks again by itself, four times 20 s apart, and the same for a busy chart;
neither answer is cached. With no chart (GeckoTerminal has none for that
time) the window says so in words and keeps everything else. A buyer that
did not answer is "Not known right now", never "Nothing". "Nothing: the draw
gave it no share" only when the buyer says the share was zero: a share that
was not bought is "None. Its 15.02 SOL share went back to its backers" (or
"was not bought"). On the stand every coin read "no share" on 2026-10-18:
the buyer, on devnet, cannot buy mainnet coins and sends the SOL back. The
words are `boughtText` in `coin-story.ts`, and "In pumpling" ends at
`left_at`, the last buy or the pool's close.

The chart is TradingView Lightweight Charts (Apache-2.0), loaded by a dynamic
import when the first window opens, not with the page; its attribution logo
stays on, as its licence asks. Prices go through `formatTinyPrice`
(`0.0₆155`), and the buy markers do not take part in the price scale: left
in, they stretched it down to nearly zero. A vertical swipe and the wheel
over the chart move the window, not the chart (`handleScroll`, `handleScale`):
by default the chart keeps them, and on a phone a swipe begun on it, 300px of
a 568px screen, did not move the sheet. A sideways drag still moves through
time, two fingers and the axes still zoom. A finished pool's window is kept
for the visit once its chart is final, any other for a minute
(`coin-story.service.ts`). The
words and marks are the pure `coin-story.ts` (scene test
`coin-story.test.mjs`); the suite is `coin-story`. `coin_story_trade_click`
counts the trade button.

## The header: links and the chat

Both headers (the main page's and `shared/site-header` on inner pages) carry
`app-header-nav` and `app-chat-launcher` next to X, since 2026-10-16.

## The story's order, and How it works

Since 2026-10-16 the scroll goes from What is it straight to Quick start. How
it works is a place of its own: reached from the header's button or `/#how`,
and once there a scroll moves between its five phases and never out of them,
by wheel, touch or keys; the section strip and the "Promote your coin" button
on its last phase are the ways out. The timeline is unchanged (How it works
still lies between What is it and Quick start on it), so the stops depend on
where the story is (`storyStopLabels`), and a step that would cross How it
works is taken the way the menu takes a jump between sections: the screen
fades, the frame moves under cover, the next stop comes in. Up from Quick start
lands on the last beat of What is it. As an ordinary page (a phone, reduced
motion) How it works comes after Quick start in the markup, and
`STORY_SECTION_SELECTORS` follows the markup's order. The suite is
`story-flow`, which watches every frame of a step for How it works.

The scale across the top of How it works is to time since 2026-10-18: 65
minutes open, 20 of buying (`HOW_NODE_AT` in `story-how-scenes.ts`, which the
dots and the animated fill both read). It was two equal hours, 0h / 1h / 2h,
while the buying took fifty minutes. To time, Locked, Buying and Sent sit in
the last quarter, and below about 880px of scale the captions of Locked and
Buying end at their dots instead of centring on them (a container query on
`.track`). The suite is `how-scale`.

`header-nav`: How it works and Past pools (and My commits when signed in, on
inner pages). From 1024px they stand in the bar; narrower they fold behind a
menu button, a disclosure of links (WAI-ARIA APG "Disclosure Navigation
Menu"), not an ARIA menu. On the main page How it works moves the story; on
inner pages it is a plain link to `/#how`, a fresh load, for the reason the
mark is. How it works left the section strip: the strip is pumpling (now with
How it works' capped mark), What is it, Quick start, and its stroke fades out
while the story is on How it works rather than standing under a wrong item.
The header bar is put away inside the story, so How it works is pressed from
the first screen. The marquee shows from md, not sm: between 640 and 768 there
is no room for it beside the menu and the chat. The suite is `header-nav`; it
checks both headers, signed in and out, keep every control on one line inside
the bar from 320px to 2560px.

`chat-launcher`: a 40px button like X. The panel lives in the CDK overlay,
not in the header: the header bar has `will-change: transform` and leaves with
a transform, which would carry a fixed panel with it. Wide, a non-modal
popover under the button (Escape or a press outside closes it, focus goes
back; a press in the sign-in dialog the chat opens does not count as outside).
Under 640px, a modal sheet over the whole screen with focus kept inside and
the page held still. The chat is created on open and destroyed on close, so
no connection opens for a visitor who never opens it. The dot on the button
is `ChatUnreadService`: the newest message id once a minute while the page is
in front, against the last seen one kept in the browser. The suite is
`chat-launcher`.

## The transactions feed

Every purchase, delivery, burn and refund of a round, newest first, each
linking to its transaction: `pool/tx-feed`. The pool page shows it while a
round buys and right after; the archive shows it for each finished round, in
a bar under the round's card that opens it. The archive asks
`/lottery/{id}/purchases` the first time a round is opened and never again
(`PurchasesService.once`): a finished round does not change, and a month of
rounds asked for up front would be a request per round for rows nobody may
look at. Times are relative on the pool page ("2 min ago", the pace of the
buying) and the clock in the archive.

The feed lays out by its own width, not the screen's (container queries): in
the archive it sits in a card. One line per row from 696px of feed, two
below, three below 360px: on a phone two lines left the middle column so
narrow that a ticker like $PUMPLING ran into the amount and a chip lay on
the transaction link. A coin's name goes under its ticker when the two do not
fit side by side, rather than being cut to half a letter. The suites are
`archive-transactions` and `tx-feed-layout`, both on the layout checks in
`e2e/lib/feed-layout.mjs`.

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
memo in the signed transaction), `burn-feed`, `burn-verify` and `burn-chip`.

The chip, "50% BURN" on a coin's row and on my page, is `pool/burn-chip` and
opens a card like the coin check's (`burnCard` in `pool/burn.ts`). On a row the
number is the coin's SOL-weighted average, Σ(sol × bps) / Σ sol, which is
exactly the share of the coin's buy the buyer burns; the card says so, and that
each backer burns only their own share, because "50% BURN" read alone sounds
like half of everybody's tokens. While the pool takes commits it adds that the
number still moves. On my page it speaks of my tokens only.

Hover styles go under `@media (hover: hover)` and skip the chosen option: on a
phone a tap leaves `:hover` on, and the old priority rule outranked `.is-active`
and left the chosen level pale with white text on it.

`api-client/` is generated: `npm run gen:api` against a running backend, or
point `openapi-gen.json`'s `input` at `app.openapi()` dumped to a file.

NB: `idl/` must match the on-chain program and the backend. When the IDL
changes, update `workers/idl/` in the same commit.

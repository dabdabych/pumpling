# Browser checks

These suites drive a real Chrome against a running frontend and check what a
unit test cannot reach: animations, your own rows being highlighted, how often
the page polls the server, behaviour on a phone.

```bash
npm start                 # one shell: the frontend on :3200
npm run e2e               # another shell: every suite
npm run e2e -- price how  # only the ones matching those names
SHOTS=1 npm run e2e -- me # with screenshots into e2e/shots
npm run test:scenes       # the maths behind the How it works scenes, no browser
```

Variables: `BASE` is the frontend address (default `http://localhost:3200`),
`CHROME_PATH` is the path to Chrome if it lives somewhere unusual.

## The suites

| Suite | What it guards |
|---|---|
| `how-anim` | the five How it works scenes: feed, price, draw, buying, delivery |
| `feed-smooth`, `feed-phone` | feeds do not jump, the total matches the row that arrived |
| `price-grow`, `price-reduced` | the price rise is visible, the number does not flicker, reduced motion stays quiet |
| `how-jump` | the "How it works" link lands exactly on the section |
| `story-nav` | moving between sections, and the page never gets stuck mid-transition |
| `commit-flow` | the path to a commit: pick a coin, the amount, the button on a phone screen |
| `commit-preflight` | the wallet opens only on a commit that passes on our node; a failing one is explained on the page instead |
| `wallet-silent` | a wallet that answers nothing: Phantom's connection checked first, a note after ten seconds, a fresh try that never sends twice, -32002 in its own words, other wallets untouched |
| `my-commits` | your own commits show up in the pool table and on your page |
| `archive` | round history, empty rounds are not shown |
| `archive-transactions` | each past pool opens to its transactions: asked once, the four kinds of row, the clock, nothing recorded, a failed request and its retry, a capped feed, the keyboard, and at every window nothing out of its card or on top of anything |
| `tx-feed-layout` | the pool page's transactions feed at every window in both phases that show it, long tickers included: nothing sticks out, overlaps or is cut to a sliver |
| `phase-switch` | the pool page in every phase of a round |
| `launch-countdown` | a scheduled launch counts down on the pool page and the first screen even with past pools closed behind it, and a pool in progress still comes first |
| `buys-feed` | the purchase feed and its Solscan links |
| `coin-hover` | the coin chart on hover, without extra requests |
| `share-card` | the card for Twitter |
| `poll-rate` | how often the page polls the server, by phase |
| `verify-round` | the "Verify this pool" button and window, including an emergency draw |
| `sign-up` | the sign-up form: the password rule, when errors appear, the way out of an unconfirmed account |
| `wallet-session` | signing in with a wallet and keeping the session |
| `wallet-connect` | the wallet list, detection, and what happens when one is missing |
| `wallet-switch` | signing out of one wallet and into another |
| `header-mark` | the mascot in the header survives dialogs and navigation |
| `mobile-fit` | nothing spills off the screen on a phone, buttons stay thumb sized |
| `pool-cta` | the main page's Commit SOL card: its two lines in every phase and never a zero, the title saying where the card goes and the card going there (the pool page with no dialog opened for you, the archive's pool after one ended), the whole drawing taking the press, the keyboard, the funnel events, and at every window, with and without motion, the words inside the card and off every coin at four moments of their wobble |
| `coin-bubbles` | the bubbles of the ten latest coins backed with 1 SOL and up: the request, every coin drawn biggest first, the biggest at most twice the smallest across, none on another or out of its card, labels inside their bubble, at every window with and without motion; each a button that opens the coin's window, and counted; hover, focus and a screen reader told what it is; a failed picture turning into initials; the empty and failed answers in words |
| `coin-story` | the coin's window from a bubble, on the launch pool's real buys and candles: ticker, name, when it took part and in which pool, the SOL behind it and what the pool bought; the mint short on screen, copied whole; the chart drawn, its library loaded only when a window opens, and told to a screen reader; GeckoTerminal named and linked; Trade on pump.fun in a new tab, counted; See pool # going to the archive; Escape and focus back on the bubble; no chart (busy, none) said in words, a running pool "→ now", a buyer that did not answer "not known", a failed answer with Try again; the window inside the screen from 320px to 2560px |
| `how-scale` | the scale across the top of How it works, to time since 2026-10-18: 65 minutes open and 20 of buying in its words and its dots, no hour left on it or in the phases, and no caption, tick or segment name on another or off the screen from 320px to 2560px, with and without motion |
| `chat-launcher` | the chat behind the header button: the dot for messages not seen and opening clearing it; a popover under the button that Escape and a press outside close, focus back, the sign-in dialog not closing it; a full-screen modal sheet on a phone with the page held still; the inner pages' header; no chat connection until it is opened |
| `header-nav` | How it works and Past pools in the header: in the bar from 1024px, behind a menu button below it (a disclosure of links, Escape, outside press, a choice closing it); How it works moving the story or linking to /#how; Past pools marked current in the archive; My commits when signed in; both headers keeping every control on one line inside the bar, signed in and out, from 320px to 2560px |
| `story-flow` | the story's order: hero, What is it, Quick start and back with no frame of How it works on the way; How it works from the header and `/#how` holding a scroll inside its five phases by wheel and keys; the strip leading out; Promote your coin on the last phase leading to the pool page with no dialog; on a phone the page reading What is it, Quick start, How it works |
| `quick-touch` | Quick start under a finger, moved by real touch flings and drags: nothing while the list flies past, then 01 to 05 one at a time once it is at rest, on a phone and in the pinned story; the Solana mark sits after the words at every width |
| `coin-screening` | the coin check's mark, the same on every coin, and its card: mouse, keyboard and finger, inside the window and off its mark, nothing in a coin row on top of anything else from 320px |
| `burn-chip` | the card under a burn chip, on a coin's row and on my page: mouse, keyboard and finger, the mark and the chip on one line each getting their own taps |
| `coin-table-fit` | from 900 to 1920px every coin row stays inside the list, with the widest content a row can hold |

A suite exits non-zero when it fails, so it works in CI.

**The rule for this folder:** a new suite has to fail on the code as it was
before the fix. A test that passes either way proves nothing, and we have shipped
one of those before.

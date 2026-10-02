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
| `phase-switch` | the pool page in every phase of a round |
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
| `quick-touch` | Quick start under a finger, moved by real touch flings and drags: nothing while the list flies past, then 01 to 05 one at a time once it is at rest, on a phone and in the pinned story; the Solana mark sits after the words at every width |
| `coin-screening` | the coin check's mark, the same on every coin, and its card: mouse, keyboard and finger, inside the window and off its mark, nothing in a coin row on top of anything else from 320px |
| `burn-chip` | the card under a burn chip, on a coin's row and on my page: mouse, keyboard and finger, the mark and the chip on one line each getting their own taps |
| `coin-table-fit` | from 900 to 1920px every coin row stays inside the list, with the widest content a row can hold |

A suite exits non-zero when it fails, so it works in CI.

**The rule for this folder:** a new suite has to fail on the code as it was
before the fix. A test that passes either way proves nothing, and we have shipped
one of those before.

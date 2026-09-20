# Security

## Reporting a vulnerability

Email **pumpling.xyz@gmail.com**. Please do not open a public issue for anything
that affects funds or the fairness of a draw.

Tell us what you found, how to reproduce it, and what an attacker gets out of
it. A transaction signature or an account address is usually enough for us to
follow along. We will confirm receipt and tell you what we are doing about it.

The same address is in the program's on-chain `security.txt`, so it can be
found without this file. If you would rather not use email, the repository's
private vulnerability reporting reaches us too.

## What is in scope

- The on-chain program `4mk8SH9un549ETZatKRkths44e2RBRkFGBmTvFie2oeH`
- The off-chain buyer and the round workers
- The API and the site

Anything that lets someone take SOL that is not theirs, bias a draw, or make a
round unfinishable is worth reporting. So is anything that makes the published
proof of a round disagree with what actually happened.

## What we already know

These are documented rather than hidden, so please do not report them as
findings unless you have found a way to make them worse.

**The admin can draw a round by hand if the oracle stops answering.**
`emergency_fulfill_randomness` lets the round's admin supply a seed. The
program refuses it the moment ORAO's randomness has arrived, and refuses it
before two minutes have passed, so it only opens on a real outage. A round drawn
this way is marked: the seed's first byte is `0xF0` or higher, and the
verification endpoint reports `randomness_source: "emergency"`.

**The program is upgradeable.** The upgrade authority can replace it. Making it
immutable is on the roadmap and will be announced when it happens.

**A round can stall if nobody drives it.** Closing deposits and starting the
buying are admin actions. There is no timeout that returns funds yet.

## Verifying a draw yourself

`GET /lottery/{id}/verification` returns everything a round rests on: the
weights commitment and the exact text it was hashed from, the request seed the
program derived, the slot whose hash went into that seed, where the randomness
came from, and the fingerprint of the algorithm that turned it into shares.

The request seed is derived, never chosen:

```
force = sha256("pumpling-vrf-force-v1" || lottery_pda || weights_hash || slot_hash)
```

Recompute it, derive the ORAO request account from it, and check that the round
used that account and no other. There is exactly one possible request per round,
which is what stops anyone from asking twice and keeping the answer they prefer.

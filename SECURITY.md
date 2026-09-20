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

Four things you can check from the chain alone, with no help from us:

1. **The commitment matches the commits.** Hash the payload the endpoint hands
   you and compare it with `weights_hash` in the round account. It was written
   before the draw.
2. **The request account is the one the seed points at.** The account is a PDA
   of `vrf_force`, and both are in the round account:
   `PDA(["orao-vrf-randomness-request", vrf_force], VRFzZoJ…)`.
3. **ORAO answered that request and no other.** Read the request account; the
   seed inside it is `vrf_force`.
4. **The round's seed is that answer.** ORAO returns 64 bytes; the round stores
   `sha256("pumpling-vrf-seed-v1" || those 64 bytes)`.

One thing you cannot recompute, and we would rather say so than let you find
out. `vrf_force` is derived from the hash of the slot in `vrf_seed_slot`, and
that hash is the slot's bank hash, which the chain keeps for 512 slots — about
three and a half minutes — and no ordinary RPC serves afterwards. So you cannot
rebuild `vrf_force` from first principles once a round is a few minutes old.

What stands in its place is the program itself. It is a
[verified build](https://github.com/dabdabych/pumpling): the bytes running on
chain rebuild exactly from this repository, and the source shows that the seed
is derived inside the program and never taken as an argument, and that the
request account is checked against that derivation before anything else
happens. So there is exactly one request a round can make, and the thing
guaranteeing it is code you can read and rebuild rather than a number we hand
you.

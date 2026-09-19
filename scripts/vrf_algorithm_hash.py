#!/usr/bin/env python3
"""
Computes `vrf_algorithm_hash` from the source and compares it with what is
pinned in the configs.

The hash is a public commitment: it is passed to `initialize` when a round is
created and means "this round is computed by this algorithm". Before this script
existed the value was hardcoded as a string in five places and derived from
nothing, so there was no way to check it.

The scheme was reconstructed by comparing with the historical value

set by commit 25d9393 (2026-06-20): it is the **sha256 of the whole
`vrf_engine.py` file**, byte for byte, comments included.

Hence a consequence that is easy to forget: editing a comment in
`vrf_engine.py` changes the commitment exactly as much as editing the formula.
That is why the script has a CI-like `--check` mode.

Usage:
    python3 scripts/vrf_algorithm_hash.py            # show the hash and the places
    python3 scripts/vrf_algorithm_hash.py --check    # exit code 1 on a mismatch
    python3 scripts/vrf_algorithm_hash.py --write    # update the value everywhere
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# The single live implementation of the algorithm.
VRF_ENGINE = REPO / "webapp/backend/application/lottery/vrf_engine.py"

# Where the value is pinned. Keep this list complete: a missed place means part
# of the system declares one algorithm on chain and computes with another.
TARGETS = [
    REPO / "docker-compose.yml",
    REPO / "run_dev.sh",
    REPO / "webapp/backend/shared/settings.py",
    REPO / "webapp/ui/src/environments/environment.ts",
    REPO / "webapp/ui/src/environments/environment.prod.ts",
]

HASH_RE = re.compile(r"0x[0-9a-fA-F]{64}")


def compute() -> str:
    return hashlib.sha256(VRF_ENGINE.read_bytes()).hexdigest()


def found_in(path: Path) -> list[str]:
    if not path.exists():
        return []
    return [m.group(0)[2:].lower() for m in HASH_RE.finditer(path.read_text())]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="only check, change nothing")
    ap.add_argument("--write", action="store_true", help="update the value everywhere")
    args = ap.parse_args()

    expected = compute()
    print(f"sha256({VRF_ENGINE.relative_to(REPO)}) = 0x{expected}")

    stale: list[tuple[Path, str]] = []
    missing: list[Path] = []
    for path in TARGETS:
        hashes = found_in(path)
        rel = path.relative_to(REPO)
        if not hashes:
            missing.append(path)
            print(f"  {rel}: value not found")
            continue
        for h in set(hashes):
            mark = "matches" if h == expected else "STALE"
            print(f"  {rel}: 0x{h[:12]}… {mark}")
            if h != expected:
                stale.append((path, h))

    if args.write and stale:
        for path, old in stale:
            text = path.read_text()
            path.write_text(text.replace(f"0x{old}", f"0x{expected}").replace(f"0x{old.upper()}", f"0x{expected}"))
            print(f"updated {path.relative_to(REPO)}")
        return 0

    if missing:
        print("\nERROR: the value is absent from the listed files — the TARGETS list is stale.")
        return 1
    if stale:
        print("\nMISMATCH: the algorithm changed and the commitment did not.")
        print("The algorithm declared on chain is not the one the round is computed with.")
        print("Fix it: python3 scripts/vrf_algorithm_hash.py --write")
        return 1

    print("\nAll consistent: the algorithm declared on chain is the one that runs.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

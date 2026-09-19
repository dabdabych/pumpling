"""
The round's weights commitment: exactly what we pin on chain before the draw.

Before the draw the program receives `weights_hash`, a fingerprint of who put
how much behind which coin. After the draw anyone should be able to rebuild the
same list, compute the same hash, and satisfy themselves that the shares were
computed from those numbers and not from adjusted ones.

So the rule for building it lives here, in one place, and both users share it:
the phase worker that puts the hash into the program, and the round verification
page that hands out the preimage. They cannot drift apart by construction — and
if they lived separately they would have drifted on the first day.

The rule:

1. Take the round's active commits and sum them per coin.
2. Round the sum to eight decimals (half up) and drop the zeros.
3. Sort by descending amount, and by coin address when equal.
4. Write it as a JSON array of pairs `[["<mint>",<amount>],…]`, with the amount
   written the way JavaScript writes it: no trailing zeros and no exponent.
5. sha256 of that string in UTF-8.
"""
from __future__ import annotations

import hashlib
import json
from decimal import Decimal, ROUND_HALF_UP

_ROUND_8 = Decimal("0.00000001")
_ZERO = Decimal(0)


def build_number_string(value: Decimal) -> str:
    """
    A number in the form JavaScript prints it.

    The hash is taken over text, so the spelling matters as much as the number:
    "1.5" and "1.50000000" give different fingerprints, and JavaScript prints
    "0.0000001" as "1e-7". The implementation was carried over from the phase
    worker word for word: it is what every past round's commitment was computed with.
    """
    normalized = value.normalize()
    if normalized == normalized.to_integral():
        return str(normalized.quantize(Decimal("1")))

    abs_value = abs(normalized)
    if abs_value != _ZERO and abs_value < Decimal("0.000001"):
        sign = "-" if normalized < _ZERO else ""
        digits = "".join(str(digit) for digit in normalized.copy_abs().as_tuple().digits)
        exponent = normalized.copy_abs().normalize().adjusted()
        mantissa = digits[0]
        tail = digits[1:].rstrip("0")
        if tail:
            mantissa = f"{mantissa}.{tail}"
        return f"{sign}{mantissa}e{exponent}"

    plain = format(normalized, "f")
    if "." in plain:
        plain = plain.rstrip("0").rstrip(".")
    return plain


def build_weights_payload(pairs: list[tuple[str, Decimal]]) -> str | None:
    """The commitment preimage: exactly the string sha256 is taken over."""
    cleaned: list[tuple[str, Decimal]] = []
    for mint, amount in pairs:
        value = Decimal(amount).quantize(_ROUND_8, rounding=ROUND_HALF_UP)
        if value <= _ZERO:
            continue
        cleaned.append((str(mint), value))

    if not cleaned:
        return None

    cleaned.sort(key=lambda item: (-item[1], item[0]))
    parts = [
        f"[{json.dumps(mint, ensure_ascii=False)},{build_number_string(amount)}]"
        for mint, amount in cleaned
    ]
    return "[" + ",".join(parts) + "]"


def weights_hash_hex(payload: str) -> str:
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_weights_commitment(pairs: list[tuple[str, Decimal]]) -> tuple[str, str] | None:
    """The preimage and its hash. `None` means there are no commits and nothing to pin."""
    payload = build_weights_payload(pairs)
    if payload is None:
        return None
    return payload, weights_hash_hex(payload)

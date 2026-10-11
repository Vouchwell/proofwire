"""Redaction: what it finds, and that hostile text cannot stall it."""

import time

from vouchwell.redact import redact


def test_hostile_text_is_scanned_in_linear_time():
    # Redaction runs on every recorded call; the email pattern was quadratic.
    for s in ["1-" * 100_000 + "x", "a." * 100_000 + ".", "a@a." * 50_000]:
        t = time.perf_counter()
        redact({"s": s})
        assert time.perf_counter() - t < 2, s[:8]


def test_ordinary_email_addresses_are_still_found():
    value, findings = redact({"to": "write to dana.o+ops@mail.acme-corp.example today"})
    assert [f.type for f in findings] == ["email"]
    assert "dana" not in value["to"]

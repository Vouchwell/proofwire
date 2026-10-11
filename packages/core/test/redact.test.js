import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/redact.js';

test('hostile text is scanned in linear time', () => {
  // Redaction runs on every recorded call, so text an agent passes along
  // must not be able to stall it. The email pattern took 26 seconds on this.
  for (const s of ['1-'.repeat(100_000) + 'x', 'a.'.repeat(100_000) + '.', 'a@a.'.repeat(50_000)]) {
    const t = performance.now();
    redact({ s });
    assert.ok(performance.now() - t < 2000, `${s.slice(0, 8)}… took ${Math.round(performance.now() - t)} ms`);
  }
});

test('ordinary email addresses are still found', () => {
  const { value, findings } = redact({ to: 'write to dana.o+ops@mail.acme-corp.example today' });
  assert.deepEqual(findings.map((f) => f.type), ['email']);
  assert.doesNotMatch(value.to, /dana/);
});

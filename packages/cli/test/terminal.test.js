import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plain } from '../src/ui.js';
import { plain as promptPlain } from '../../proxy/src/approve.js';

test('recorded strings cannot drive the terminal', () => {
  // A tool name like this would erase its own line and print a fake one.
  const hostile = 'payments.refund\x1b[2K\r\x1b[32mread_only\x1b[0m\u202e\u2028';
  for (const f of [plain, promptPlain]) {
    const shown = f(hostile);
    assert.doesNotMatch(shown, /[\u0000-\u001f\u007f-\u009f\u2028\u202e]/);
    assert.match(shown, /^payments\.refund\\u001b\[2K\\u000d/);
  }
  assert.equal(plain('crm.lookup'), 'crm.lookup');
  assert.equal(plain(undefined), '');
});

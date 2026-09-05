// Fixture used by tests/run.test.mjs. Deliberately contains one passing and
// one failing test, so the real `node --test` summary line and the real
// non-zero exit code can both be exercised.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('addition works', () => {
  assert.strictEqual(1 + 1, 2);
});

test('this one fails on purpose, to exercise a real non-zero exit', () => {
  assert.strictEqual(1 + 1, 3);
});

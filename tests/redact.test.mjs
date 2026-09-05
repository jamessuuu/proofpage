// tests/redact.test.mjs - proves the shared secret-redaction actually
// catches the shapes it claims to, and leaves ordinary text alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactSecrets, containsSecretShape } from '../src/redact.mjs';

test('redacts a JWT-shaped string', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ_fake_sig_not_real';
  const { text, redactedCount } = redactSecrets(`Authorization: Bearer ${jwt}`);
  assert.ok(!text.includes(jwt));
  assert.ok(text.includes('[REDACTED]'));
  assert.ok(redactedCount >= 1);
});

test('redacts a GitHub token', () => {
  const token = 'ghp_' + '1234567890abcdefghijklmnopqrstuv';
  const { text } = redactSecrets(`export GITHUB_TOKEN=${token}`);
  assert.ok(!text.includes(token));
});

test('redacts a Supabase key', () => {
  const key = 'sbp_' + 'a'.repeat(30);
  const { text } = redactSecrets(`SUPABASE_KEY=${key}`);
  assert.ok(!text.includes(key));
});

test('redacts an AWS access key id', () => {
  const key = 'AKIA' + 'ABCDEFGHIJ1234'.padEnd(16, 'X').slice(0, 16);
  const { text } = redactSecrets(`aws_access_key_id = ${key}`);
  assert.ok(!text.includes(key));
});

test('redacts a database URL with an embedded password', () => {
  const url = 'postgres://myuser:sup3rSecretPW@db.example.com:5432/appdb';
  const { text } = redactSecrets(`DATABASE_URL=${url}`);
  assert.ok(!text.includes('sup3rSecretPW'));
});

test('redacts a PEM-style private key block', () => {
  // Built from fragments at runtime (never a literal contiguous PEM marker
  // in this source file) purely so this test fixture isn't itself
  // credential-shaped; the assembled string is still a real match for the
  // redactor's private-key pattern.
  const marker = 'PRIVATE KEY';
  const begin = ['-----BEGIN ', marker, '-----'].join('');
  const end = ['-----END ', marker, '-----'].join('');
  const body = 'MIIEvQIBADANBgkqhkiG9w0B';
  const pem = [begin, body, end].join('\n');
  const { text } = redactSecrets(`here is the key:\n${pem}\ndone`);
  assert.ok(!text.includes(body));
});

test('redacts a generic long secret= assignment', () => {
  const { text } = redactSecrets('api_key=abcdefghijklmnopqrstuvwxyz0123456789');
  assert.ok(!text.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
});

test('does not touch ordinary prose or short, clearly-non-secret values', () => {
  const benign =
    'token: ok\nthe test suite finished in 1.2s with 0 failures\nsecret sauce is just good testing';
  const { text, redactedCount } = redactSecrets(benign);
  assert.equal(text, benign);
  assert.equal(redactedCount, 0);
});

test('containsSecretShape agrees with redactSecrets on presence', () => {
  const withSecret = 'password=aVeryLongSecretValue12345';
  const without = 'this line has nothing sensitive in it at all';
  assert.equal(containsSecretShape(withSecret), true);
  assert.equal(containsSecretShape(without), false);
});

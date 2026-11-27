import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOAuthCallback } from './oauthNative';

test('parses valid callback', () => {
  const r = parseOAuthCallback('anisocial://auth/callback?code=abc123');
  assert.equal(r.ok, true);
  assert.equal(r.code, 'abc123');
});

test('rejects invalid protocol/host/path', () => {
  assert.equal(parseOAuthCallback('https://auth/callback?code=x').ok, false);
  assert.equal(parseOAuthCallback('anisocial://other/callback?code=x').ok, false);
  assert.equal(parseOAuthCallback('anisocial://auth/other?code=x').ok, false);
});

test('missing code', () => {
  const r = parseOAuthCallback('anisocial://auth/callback?state=1');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'missing_code');
});

test('oauth error', () => {
  const r = parseOAuthCallback('anisocial://auth/callback?error=access_denied');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'access_denied');
});

test('duplicate code handling is idempotent at parse level', () => {
  const r1 = parseOAuthCallback('anisocial://auth/callback?code=dup');
  const r2 = parseOAuthCallback('anisocial://auth/callback?code=dup');
  assert.equal(r1.code, r2.code);
});
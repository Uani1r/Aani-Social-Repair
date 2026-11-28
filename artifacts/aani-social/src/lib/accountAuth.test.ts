import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOGIN_IDENTIFIER_MESSAGE,
  classifyLoginIdentifier,
  normalizePhoneToE164,
} from './accountAuth';

const IRAQI_LOCAL = '07701234567';
const IRAQI_E164 = '+9647701234567';

test('an email goes to the email route, lower-cased', () => {
  assert.deepEqual(
    classifyLoginIdentifier(' Someone@Example.com '),
    { kind: 'email', email: 'someone@example.com' },
  );
});

test('a malformed email is refused instead of being read as a username', () => {
  assert.deepEqual(
    classifyLoginIdentifier('someone@'),
    { kind: 'invalid', message: LOGIN_IDENTIFIER_MESSAGE },
  );
});

test('an Iraqi local mobile number goes to the phone route as E.164', () => {
  assert.deepEqual(classifyLoginIdentifier(IRAQI_LOCAL), { kind: 'phone', phone: IRAQI_E164 });
  assert.deepEqual(classifyLoginIdentifier('0770 123 4567'), { kind: 'phone', phone: IRAQI_E164 });
});

test('an international number goes to the phone route as E.164', () => {
  for (const value of ['+9647701234567', '+964 770 123 4567', '009647701234567']) {
    assert.deepEqual(classifyLoginIdentifier(value), { kind: 'phone', phone: IRAQI_E164 }, value);
  }
});

test('short numeric usernames stay usernames, never phone numbers', () => {
  for (const value of ['123', '12345', '1234567890', '7701234567', '0770123456']) {
    assert.deepEqual(classifyLoginIdentifier(value), { kind: 'username', username: value }, value);
  }
});

test('long numeric usernames stay usernames, never phone numbers', () => {
  for (const value of ['12345678901', '123456789012', '12345678901234567890123456789012']) {
    assert.deepEqual(classifyLoginIdentifier(value), { kind: 'username', username: value }, value);
  }
});

test('a numeric username shaped like a local number can be forced with @', () => {
  assert.deepEqual(classifyLoginIdentifier('@07701234567'), { kind: 'username', username: '07701234567' });
  assert.deepEqual(classifyLoginIdentifier('@123456789012'), { kind: 'username', username: '123456789012' });
});

test('an @ prefix forces the username route and keeps the current rules', () => {
  assert.deepEqual(classifyLoginIdentifier('@Aani.User'), { kind: 'username', username: 'aani.user' });
  // الحد الأدنى محرف واحد: @ab و@a اسمان صالحان، لا مرفوضان.
  assert.deepEqual(classifyLoginIdentifier('@ab'), { kind: 'username', username: 'ab' });
  assert.deepEqual(classifyLoginIdentifier('@a'), { kind: 'username', username: 'a' });
  assert.deepEqual(classifyLoginIdentifier('@7'), { kind: 'username', username: '7' });
  assert.deepEqual(classifyLoginIdentifier('@has space'), { kind: 'invalid', message: LOGIN_IDENTIFIER_MESSAGE });
});

test('one-character and two-character usernames are accepted by the new rules', () => {
  for (const value of ['a', '7', 'ab', '12', '123']) {
    assert.deepEqual(classifyLoginIdentifier(value), { kind: 'username', username: value }, value);
  }
});

test('text usernames with dots and underscores keep working', () => {
  assert.deepEqual(classifyLoginIdentifier('aani.user'), { kind: 'username', username: 'aani.user' });
  assert.deepEqual(classifyLoginIdentifier(' Aani_User_2 '), { kind: 'username', username: 'aani_user_2' });
});

test('anything that is neither email, phone nor username is refused', () => {
  for (const value of ['', '   ', '+12', 'a b', '@', 'name@', 'user-name']) {
    assert.deepEqual(classifyLoginIdentifier(value), { kind: 'invalid', message: LOGIN_IDENTIFIER_MESSAGE }, value);
  }
});

test('the phone route keeps the existing E.164 behaviour', () => {
  assert.equal(normalizePhoneToE164(IRAQI_LOCAL), IRAQI_E164);
  assert.equal(normalizePhoneToE164('+9647701234567'), IRAQI_E164);
  assert.equal(normalizePhoneToE164('7701234567'), IRAQI_E164);
  assert.equal(normalizePhoneToE164('12'), null);
});

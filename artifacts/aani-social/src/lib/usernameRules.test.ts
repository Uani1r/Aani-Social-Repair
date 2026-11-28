import assert from 'node:assert/strict';
import test from 'node:test';

import {
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
  describeUsernameClaimError,
  isUsernameRegistryState,
  isUsernameSelectable,
  normalizeUsernameInput,
  usernameStateMessage,
  validateUsername,
  USERNAME_MESSAGES,
} from './usernameRules';

/**
 * قواعد اسم المستخدم الجديدة: محرف واحد على الأقل (لا ثلاثة)، و32 على الأكثر،
 * بنفس المحارف المعتمدة سابقاً. حد أدنى قديم بـ3 محارف كان يرفض `a` و`7`،
 * وهذا الاختبار يمنع عودته في أي موضع.
 */

const ACCEPTED = [
  'a',
  '7',
  'ab',
  '12',
  '123',
  '12345678901234567890', // 20 رقماً
  'abcdefghijklmnopqrst', // 20 حرفاً
  'a1',
  'a_1.b',
  '7_7',
  'a'.repeat(USERNAME_MAX_LENGTH),
];

const REJECTED = [
  '',
  ' ',
  '  ',
  'a b',
  ' a',
  'a ',
  'a\tb',
  'user name',
  'user-name',
  'user@name',
  'user#1',
  'مستخدم',
  'أ',
  'user/name',
  'user+name',
  'a'.repeat(USERNAME_MAX_LENGTH + 1),
];

test('الحدود المعلنة: 1 و32 (لا 3)', () => {
  assert.equal(USERNAME_MIN_LENGTH, 1);
  assert.equal(USERNAME_MAX_LENGTH, 32);
  assert.equal(USERNAME_PATTERN.test('a'), true);
  assert.equal(USERNAME_PATTERN.test('ab'), true);
  assert.equal(USERNAME_PATTERN.test('7'), true);
});

test('يقبل: حرفاً واحداً، رقماً واحداً، حرفين، رقمين، ثلاثة أرقام، أرقاماً وحروفاً طويلة، ومختلطاً', () => {
  for (const value of ACCEPTED) {
    const result = validateUsername(value);
    assert.equal(result.ok, true, `${value} must be accepted`);
    assert.equal(result.ok && result.username, value.toLowerCase());
    assert.equal(USERNAME_PATTERN.test(value.toLowerCase()), true, `${value} must match the pattern`);
  }
});

test('يقبل 32 محرفاً ويرفض 33', () => {
  assert.equal(validateUsername('b'.repeat(32)).ok, true);
  assert.equal(validateUsername('b'.repeat(33)).ok, false);
  assert.deepEqual(validateUsername('b'.repeat(33)), {
    ok: false,
    code: 'too_long',
    message: USERNAME_MESSAGES.tooLong,
  });
});

test('يرفض المسافات والمحارف غير المسموحة برسالة المحارف لا الطول', () => {
  for (const value of REJECTED) {
    const result = validateUsername(value);
    assert.equal(result.ok, false, `${JSON.stringify(value)} must be refused`);
  }

  for (const value of ['a b', 'user-name', 'user@name', 'مستخدم', 'user/name']) {
    const result = validateUsername(value);
    assert.equal(result.ok, false, `${value} must be refused`);
    assert.equal(result.ok === false && result.code, 'invalid_characters', value);
  }

  for (const value of ['', ' ', '  ']) {
    const result = validateUsername(value);
    assert.equal(result.ok === false && result.code, 'empty', JSON.stringify(value));
  }
});

/** الاسم المطبَّع أو تصنيف رفض واضح (لا تحويل أنواع ولا افتراضات). */
const acceptedUsername = (value: string): string => {
  const result = validateUsername(value);
  return result.ok ? result.username : `refused:${result.code}`;
};

test('التطبيع: بلا @ وبأحرف صغيرة وبلا فراغات زائدة', () => {
  assert.equal(normalizeUsernameInput('@User.Name'), 'user.name');
  assert.equal(normalizeUsernameInput('  @USER.NAME  '), 'user.name');
  assert.equal(normalizeUsernameInput('@@@user'), 'user');
  assert.equal(normalizeUsernameInput('A'), 'a');
  assert.equal(normalizeUsernameInput(undefined), '');
  assert.equal(normalizeUsernameInput(123), '');

  // اختلاف حالة الأحرف لا يُنشئ اسمين: الناتج واحد.
  assert.equal(acceptedUsername('User1'), 'user1');
  assert.equal(acceptedUsername('USER'), acceptedUsername('user'));
  assert.equal(acceptedUsername('MiXeD.1'), 'mixed.1');
});

test('حالات السجل: الإتاحة والملكية الخاصة فقط', () => {
  assert.equal(isUsernameSelectable('available'), true);
  assert.equal(isUsernameSelectable('self'), true);
  for (const state of ['reserved', 'blocked', 'claimed', 'unknown'] as const) {
    assert.equal(isUsernameSelectable(state), false, state);
  }

  for (const value of ['available', 'reserved', 'blocked', 'claimed', 'self', 'unknown']) {
    assert.equal(isUsernameRegistryState(value), true, value);
  }
  for (const value of ['AVAILABLE', 'reserve', '', null, 1, {}]) {
    assert.equal(isUsernameRegistryState(value), false, String(value));
  }
});

test('رسالة كل حالة عربية ومميزة', () => {
  const messages = new Set(
    (['available', 'reserved', 'blocked', 'claimed', 'self', 'unknown'] as const).map(usernameStateMessage),
  );
  assert.equal(messages.size, 6, 'every state must have its own message');
  assert.equal(usernameStateMessage('reserved'), USERNAME_MESSAGES.reserved);
  assert.equal(usernameStateMessage('blocked'), USERNAME_MESSAGES.blocked);
  assert.equal(usernameStateMessage('claimed'), USERNAME_MESSAGES.taken);
  assert.equal(usernameStateMessage('unknown'), USERNAME_MESSAGES.checkUnavailable);
});

test('رسائل أخطاء المطالبة تُترجم من أسباب قاعدة البيانات', () => {
  assert.equal(describeUsernameClaimError({ code: '23505' }), USERNAME_MESSAGES.taken);
  assert.equal(describeUsernameClaimError({ code: '42501', message: 'username reserved' }), USERNAME_MESSAGES.reserved);
  assert.equal(describeUsernameClaimError({ code: '42501', message: 'username blocked' }), USERNAME_MESSAGES.blocked);
  assert.equal(describeUsernameClaimError({ code: '22023', message: 'invalid_username' }), USERNAME_MESSAGES.invalidCharacters);
  assert.equal(describeUsernameClaimError({ code: '42883' }), USERNAME_MESSAGES.checkUnavailable);
  assert.equal(describeUsernameClaimError({ code: 'PGRST202' }), USERNAME_MESSAGES.checkUnavailable);
  assert.equal(describeUsernameClaimError(null), USERNAME_MESSAGES.checkUnavailable);
  // لا نص قاعدة بيانات خام في أي رسالة.
  for (const error of [
    { code: '23505', message: 'duplicate key value violates unique constraint' },
    { code: '42501', message: 'username reserved' },
  ]) {
    const message = describeUsernameClaimError(error);
    assert.equal(/constraint|POSTGRES|postgres/i.test(message), false);
  }
});

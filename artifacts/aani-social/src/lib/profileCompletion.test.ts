import assert from 'node:assert/strict';
import test from 'node:test';

import { ONBOARDING_TERMS_VERSION } from './onboarding';
import {
  PROFILE_COMPLETION_MESSAGES,
  completeOnboarding,
  readBirthDate,
  validateProfileDraft,
  type ProfileDraft,
} from './profileCompletion';
import { USERNAME_MESSAGES } from './usernameRules';

/**
 * نموذج إكمال التسجيل: نفس التحقق للتسجيل بالبريد ولمستخدم Google.
 * لا حفظ بلا موافقة، ولا اختيار افتراضي للجنس، واسم المستخدم بقواعد 1–32.
 * والحفظ لا يكتب على profiles مباشرة: دالة ذرية واحدة تعيد قرار السجل.
 */

const TODAY = new Date(Date.UTC(2026, 10, 28));

const VALID: ProfileDraft = {
  fullName: 'مستخدم آني',
  username: 'a',
  birthDate: '1995-04-12',
  gender: 'male',
  termsAccepted: true,
};

type Call = { fn: string; args?: Record<string, unknown> };

function makeClient(options: {
  data?: unknown;
  error?: { code?: string | null; message?: string | null } | null;
  throws?: boolean;
  calls?: Call[];
} = {}) {
  const calls = options.calls ?? [];
  return {
    calls,
    async rpc(fn: string, args?: Record<string, unknown>) {
      calls.push({ fn, args });
      if (options.throws) throw new Error('network down');
      return { data: options.data ?? null, error: options.error ?? null };
    },
  };
}

test('تاريخ الميلاد: صيغة حقيقية بين 1900 واليوم', () => {
  assert.equal(readBirthDate('1995-04-12', TODAY), '1995-04-12');
  assert.equal(readBirthDate('1900-01-01', TODAY), '1900-01-01');
  assert.equal(readBirthDate('2026-11-28', TODAY), '2026-11-28');
  for (const value of [
    '2026-11-29', // غداً
    '1899-12-31',
    '1995-13-01',
    '1995-02-30',
    '1995-4-12',
    '12/04/1995',
    '',
    '   ',
    null,
    19950412,
  ]) {
    assert.equal(readBirthDate(value, TODAY), null, String(value));
  }
});

test('نموذج صالح: حرف واحد كاسم مستخدم، جنس صريح، وموافقة', () => {
  const result = validateProfileDraft(VALID, TODAY);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, {
    fullName: 'مستخدم آني',
    username: 'a',
    birthDate: '1995-04-12',
    gender: 'male',
    termsVersion: ONBOARDING_TERMS_VERSION,
  });
  assert.notEqual(ONBOARDING_TERMS_VERSION.trim(), '', 'the consent version must be recorded');
});

test('نموذج صالح: أسماء قصيرة جداً وطويلة وأرقام فقط', () => {
  for (const username of ['7', 'ab', '12', '123', '12345678901234567890', 'abcdefghijklmnopqrst', 'a1', 'A'.repeat(3)]) {
    const result = validateProfileDraft({ ...VALID, username }, TODAY);
    assert.equal(result.ok, true, username);
    assert.equal(result.ok && result.value.username, username.toLowerCase());
  }
});

test('لا حفظ بلا موافقة، ولا جنس مفترض، ولا بريد أو كلمة مرور', () => {
  const noConsent = validateProfileDraft({ ...VALID, termsAccepted: false }, TODAY);
  assert.equal(noConsent.ok, false);
  assert.equal(noConsent.ok === false && noConsent.field, 'terms');
  assert.equal(noConsent.ok === false && noConsent.message, PROFILE_COMPLETION_MESSAGES.termsRequired);

  const noGender = validateProfileDraft({ ...VALID, gender: null }, TODAY);
  assert.equal(noGender.ok, false);
  assert.equal(noGender.ok === false && noGender.field, 'gender');
  assert.equal(noGender.ok === false && noGender.message, PROFILE_COMPLETION_MESSAGES.genderRequired);
});

test('الاسم الكامل وتاريخ الميلاد واسم المستخدم: رسالة الحقل نفسه', () => {
  const cases: Array<{ patch: Partial<ProfileDraft>; field: string }> = [
    { patch: { fullName: '   ' }, field: 'fullName' },
    { patch: { fullName: 'ن'.repeat(121) }, field: 'fullName' },
    { patch: { username: '' }, field: 'username' },
    { patch: { username: 'a b' }, field: 'username' },
    { patch: { username: 'user-name' }, field: 'username' },
    { patch: { username: 'x'.repeat(33) }, field: 'username' },
    { patch: { birthDate: '' }, field: 'birthDate' },
    { patch: { birthDate: '1995-02-30' }, field: 'birthDate' },
    { patch: { birthDate: '2099-01-01' }, field: 'birthDate' },
  ];

  for (const item of cases) {
    const result = validateProfileDraft({ ...VALID, ...item.patch }, TODAY);
    assert.equal(result.ok, false, JSON.stringify(item.patch));
    assert.equal(result.ok === false && result.field, item.field, JSON.stringify(item.patch));
    assert.notEqual(result.ok === false && result.message, '');
  }
});

test('الحفظ يمر بدالة ذرية واحدة بالحقول والموافقة وإصدارها', async () => {
  const client = makeClient({ data: 'a' });
  const result = await completeOnboarding({ ...VALID, username: '@A' }, client, TODAY);

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.username, 'a');
  assert.deepEqual(client.calls, [{
    fn: 'aani_complete_onboarding',
    args: {
      p_username: 'a',
      p_full_name: 'مستخدم آني',
      p_birth_date: '1995-04-12',
      p_gender: 'male',
      p_terms_version: ONBOARDING_TERMS_VERSION,
    },
  }]);
});

test('نموذج غير صالح لا يُرسل أي طلب', async () => {
  const client = makeClient({ data: 'a' });
  const result = await completeOnboarding({ ...VALID, termsAccepted: false }, client, TODAY);

  assert.equal(result.ok, false);
  assert.deepEqual(client.calls, []);
});

test('أخطاء الخادم تُترجم: مأخوذ، محجوز، ممنوع، موافقة، ودالة غير مثبتة', async () => {
  const cases: Array<{
    error: { code?: string | null; message?: string | null } | null;
    field: string;
    message: string;
  }> = [
    { error: { code: '23505', message: 'duplicate key value violates unique constraint' }, field: 'username', message: USERNAME_MESSAGES.taken },
    { error: { code: '42501', message: 'username reserved' }, field: 'username', message: USERNAME_MESSAGES.reserved },
    { error: { code: '42501', message: 'username blocked' }, field: 'username', message: USERNAME_MESSAGES.blocked },
    { error: { code: '22023', message: 'invalid_username' }, field: 'username', message: USERNAME_MESSAGES.invalidCharacters },
    { error: { code: '22023', message: 'terms_required' }, field: 'terms', message: PROFILE_COMPLETION_MESSAGES.termsRequired },
    { error: { code: '42883', message: 'could not find the function public.aani_complete_onboarding' }, field: 'save', message: PROFILE_COMPLETION_MESSAGES.notInstalled },
    { error: { code: 'PGRST202', message: 'not found' }, field: 'save', message: PROFILE_COMPLETION_MESSAGES.notInstalled },
    { error: { code: '500', message: 'boom' }, field: 'save', message: PROFILE_COMPLETION_MESSAGES.saveFailed },
  ];

  for (const item of cases) {
    const result = await completeOnboarding(VALID, makeClient({ error: item.error }), TODAY);
    assert.equal(result.ok, false, JSON.stringify(item.error));
    assert.equal(result.ok === false && result.field, item.field, JSON.stringify(item.error));
    assert.equal(result.ok === false && result.message, item.message, JSON.stringify(item.error));
  }

  const throwing = await completeOnboarding(VALID, makeClient({ throws: true }), TODAY);
  assert.equal(throwing.ok, false);
  assert.equal(throwing.ok === false && throwing.message, PROFILE_COMPLETION_MESSAGES.saveFailed);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_ONBOARDING_STATE,
  fetchMyOnboardingState,
  fullNameFromProvider,
  looksLikePlaceholderUsername,
  onboardingIsComplete,
  parseOnboardingPayload,
  suggestedUsernameFromProvider,
} from './onboarding';

/**
 * اكتمال التسجيل يُقرأ من `onboarding_completed_at` وحده:
 *   * لقطة غائبة أو فاشلة → ليست اكتمالاً.
 *   * ترحيل غير مطبَّق (الدالة غير موجودة) → الحسابات القائمة تُعامل كاملة،
 *     فلا يُفرض على أحد إعادة تسجيل بسبب ترحيل لم يُطبَّق بعد.
 *   * الاسم البديل الذي ينشئه المشغّل ليس دليلاً على الاكتمال.
 */

test('قراءة صف الحالة من الاستجابة', () => {
  assert.deepEqual(
    parseOnboardingPayload([{
      onboarding_completed_at: '2026-11-01T10:00:00.000Z',
      terms_accepted_at: '2026-11-01T10:00:00.000Z',
      terms_version: 'aani-terms-2026-11',
      username: 'a',
    }]),
    {
      onboardingCompletedAt: '2026-11-01T10:00:00.000Z',
      termsAcceptedAt: '2026-11-01T10:00:00.000Z',
      termsVersion: 'aani-terms-2026-11',
      username: 'a',
    },
  );

  // صف ناقص: كل ما لم يوجد null، ولا استنتاج من غيره.
  assert.deepEqual(parseOnboardingPayload([{ username: 'ab' }]), {
    ...EMPTY_ONBOARDING_STATE,
    username: 'ab',
  });

  assert.equal(parseOnboardingPayload([]), null);
  assert.equal(parseOnboardingPayload(null), null);
  assert.equal(parseOnboardingPayload([null]), null);
  assert.equal(parseOnboardingPayload('a'), null);
});

test('اكتمال التسجيل: التاريخ وحده، والغائب ليس اكتمالاً', () => {
  assert.equal(onboardingIsComplete(null), false);
  assert.equal(onboardingIsComplete(undefined), false);
  assert.equal(
    onboardingIsComplete({ supported: true, state: { ...EMPTY_ONBOARDING_STATE, onboardingCompletedAt: null } }),
    false,
  );
  assert.equal(
    onboardingIsComplete({ supported: true, state: { ...EMPTY_ONBOARDING_STATE, onboardingCompletedAt: '2026-11-01T00:00:00Z' } }),
    true,
  );
  // لا ترحيل بعد: القائمون لا يُعاد تسجيلهم.
  assert.equal(onboardingIsComplete({ supported: false, state: null }), true);
});

test('قراءة الحالة: موجودة، غير مثبتة، وفاشلة', async () => {
  const present = await fetchMyOnboardingState({
    async rpc() {
      return {
        data: [{ onboarding_completed_at: null, terms_accepted_at: null, terms_version: null, username: 'abc' }],
        error: null,
      };
    },
  });
  assert.equal(present?.supported, true);
  assert.equal(present?.state?.username, 'abc');
  assert.equal(onboardingIsComplete(present), false);

  const missingFunction = await fetchMyOnboardingState({
    async rpc() {
      return { data: null, error: { code: '42883', message: 'function does not exist' } };
    },
  });
  assert.deepEqual(missingFunction, { supported: false, state: null });
  assert.equal(onboardingIsComplete(missingFunction), true);

  for (const rpc of [
    async () => ({ data: null, error: { code: '500', message: 'boom' } }),
    async () => ({ data: null, error: null }),
    async () => { throw new Error('network down'); },
  ]) {
    const failed = await fetchMyOnboardingState({ rpc });
    assert.equal(failed, null);
    // فشل القراءة لا يُعامل اكتمالاً: لا يُفتح التطبيق.
    assert.equal(onboardingIsComplete(failed), false);
  }
});

test('الاسم البديل الذي ينشئه المشغّل ليس اختيار المستخدم', () => {
  const userId = '11111111-2222-3333-4444-555555555555';
  // معرّف الحساب بلا شرطات: ما ينشئه المشغّل عند غياب اسم صالح.
  assert.equal(looksLikePlaceholderUsername('11111111222233334444555555555555', userId), true);
  assert.equal(looksLikePlaceholderUsername('user_11111111', userId), true);
  assert.equal(looksLikePlaceholderUsername('', userId), true);
  assert.equal(looksLikePlaceholderUsername(null, userId), true);
  // اسم حقيقي قصير جداً (محرف واحد) ليس بديلاً.
  assert.equal(looksLikePlaceholderUsername('a', userId), false);
  assert.equal(looksLikePlaceholderUsername('7', userId), false);
  assert.equal(looksLikePlaceholderUsername('user_name', userId), false);
});

test('تعبئة أولية من Google: الاسم الكامل واسم مستخدم مقترح', () => {
  const googleUser = {
    email: 'Jane.Doe@example.com',
    user_metadata: { full_name: '  Jane Doe  ', name: 'Jane' },
  };
  assert.equal(fullNameFromProvider(googleUser), 'Jane Doe');
  assert.equal(fullNameFromProvider({ user_metadata: { name: 'Jane' } }), 'Jane');
  assert.equal(fullNameFromProvider({ user_metadata: { full_name: 'مستخدم' } }), '', 'a placeholder is not a name');
  assert.equal(fullNameFromProvider(null), '');

  assert.equal(suggestedUsernameFromProvider({ user_metadata: { username: 'Jane.Doe' } }), 'jane.doe');
  assert.equal(suggestedUsernameFromProvider({ user_metadata: { username: 'AB' } }), 'ab');
  assert.equal(suggestedUsernameFromProvider({ user_metadata: { username: '1' } }), '1');
  assert.equal(suggestedUsernameFromProvider({ email: '7@example.com' }), '7');
  // اقتراح بلا محارف صالحة → لا اقتراح (لا اسم مخترع).
  assert.equal(suggestedUsernameFromProvider({ email: 'مستخدم@example.com' }), '');
  assert.equal(suggestedUsernameFromProvider({ user_metadata: { username: 'a'.repeat(33) } }), '');
  assert.equal(suggestedUsernameFromProvider(null), '');
});

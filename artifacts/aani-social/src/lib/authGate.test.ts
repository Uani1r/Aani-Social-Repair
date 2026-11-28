import assert from 'node:assert/strict';
import test from 'node:test';

import { AUTH_GATE_MESSAGES, resolveAuthGate, type AuthGateInput, type ProfileLoadState } from './authGate';

/**
 * بوابة التوجيه: لا تطبيق قبل تحميل الملف، ولا اكتمال بغياب الملف أو فشل
 * تحميله، والمستخدم غير المكتمل يرى الإكمال فقط (حتى مع /feed في العنوان).
 */

const COMPLETE: AuthGateInput = {
  authLoading: false,
  authResolved: true,
  hasUser: true,
  profileState: 'ready',
  onboardingComplete: true,
};

test('لا تطبيق قبل حسم الجلسة ولا أثناء تحميلها', () => {
  assert.equal(resolveAuthGate({ ...COMPLETE, authLoading: true }), 'loading');
  assert.equal(resolveAuthGate({ ...COMPLETE, authResolved: false }), 'loading');
});

test('غير المسجّل يرى تسجيل الدخول، والمكتمل يرى التطبيق', () => {
  assert.equal(resolveAuthGate({ ...COMPLETE, hasUser: false }), 'signin');
  assert.equal(resolveAuthGate(COMPLETE), 'app');
});

test('مستخدم Google جديد: ملف مكتمل الجلب بلا إكمال تسجيل → واجهة الإكمال', () => {
  assert.equal(resolveAuthGate({ ...COMPLETE, onboardingComplete: false }), 'onboarding');
});

test('غياب الملف أو فشل تحميله ليس اكتمالاً وليس تطبيقاً', () => {
  // ملف غائب: واجهة الإكمال، لا التطبيق.
  assert.equal(resolveAuthGate({ ...COMPLETE, profileState: 'missing' }), 'onboarding');
  // فشل تحميل: لا تطبيق حتى لو ادّعت الحالة اكتمالاً.
  assert.equal(
    resolveAuthGate({ ...COMPLETE, profileState: 'failed', onboardingComplete: true }),
    'profile_error',
  );
  assert.equal(
    resolveAuthGate({ ...COMPLETE, profileState: 'failed', onboardingComplete: false }),
    'profile_error',
  );
  // أثناء التحميل أو قبل بدئه: انتظار، لا تطبيق.
  assert.equal(resolveAuthGate({ ...COMPLETE, profileState: 'loading' }), 'loading');
  assert.equal(resolveAuthGate({ ...COMPLETE, profileState: 'idle' }), 'loading');
});

test('إعادة التحميل لا تتجاوز الحماية: كل جلب يبدأ من جديد بالانتظار', () => {
  // إعادة تحميل صفحة مستخدم غير مكتمل: الحالة تبدأ idle فلا يُعرض التطبيق.
  const afterReload: AuthGateInput = {
    ...COMPLETE,
    profileState: 'idle',
    onboardingComplete: false,
  };
  assert.equal(resolveAuthGate(afterReload), 'loading');

  // ثم تُحسم إلى عدم الاكتمال → الإكمال، لا صفحات داخلية.
  assert.equal(resolveAuthGate({ ...afterReload, profileState: 'ready' }), 'onboarding');
  assert.equal(resolveAuthGate({ ...afterReload, profileState: 'ready', onboardingComplete: true }), 'app');
});

test('لا تركيبة تعطي التطبيق بلا ملف محمّل ولا بلا إكمال', () => {
  const states: ProfileLoadState[] = ['idle', 'loading', 'ready', 'missing', 'failed'];
  for (const profileState of states) {
    for (const onboardingComplete of [true, false]) {
      for (const hasUser of [true, false]) {
        for (const authResolved of [true, false]) {
          const gate = resolveAuthGate({ authLoading: false, authResolved, hasUser, profileState, onboardingComplete });
          if (gate === 'app') {
            assert.equal(hasUser, true, 'app requires a session');
            assert.equal(authResolved, true, 'app requires a resolved session');
            assert.equal(profileState, 'ready', 'app requires a loaded profile');
            assert.equal(onboardingComplete, true, 'app requires a completed onboarding');
          }
          if (gate === 'onboarding') {
            assert.equal(hasUser, true, 'onboarding requires a session');
            assert.equal(authResolved, true, 'onboarding requires a resolved session');
            assert.equal(profileState === 'ready' || profileState === 'missing', true, 'onboarding requires a settled profile');
          }
        }
      }
    }
  }
});

test('رسالة فشل تحميل الملف واضحة وفيها إعادة محاولة وتسجيل خروج', () => {
  assert.match(AUTH_GATE_MESSAGES.profileLoadFailed, /ملفك الشخصي/);
  assert.equal(AUTH_GATE_MESSAGES.retry, 'إعادة المحاولة');
  assert.equal(AUTH_GATE_MESSAGES.signOut, 'تسجيل الخروج');
});

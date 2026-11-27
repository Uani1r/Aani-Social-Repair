import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PUSH_SIGN_OUT_DONE_WITHOUT_DEVICE_MESSAGE,
  PUSH_SIGN_OUT_DONE_WITH_DEVICE_MESSAGE,
  PUSH_SIGN_OUT_REVOKE_FAILED_MESSAGE,
  PUSH_SIGN_OUT_SESSION_CHECK_FAILED_MESSAGE,
  PUSH_SIGN_OUT_SESSION_FAILED_MESSAGE,
  endSessionAfterAccountDeletion,
  signOutThisDevice,
  type DeviceSignOutDeps,
} from './pushSignOut';

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));
const USER_ID = 'a0000000-0000-0000-0000-00000000000a';
const INSTALLATION_ID = '11111111-1111-4111-a111-111111111111';

type Options = {
  userId?: string | null;
  installationId?: string | null;
  revokeError?: unknown;
  revokeThrows?: boolean;
  sessionError?: unknown;
  sessionThrows?: boolean;
};

function createDeps(options: Options = {}) {
  const calls: string[] = [];
  const revokedInstallations: string[] = [];
  const deps: DeviceSignOutDeps = {
    readUserId: async () => {
      calls.push('readUserId');
      return options.userId === undefined ? USER_ID : options.userId;
    },
    readInstallationId: () => {
      calls.push('readInstallationId');
      return options.installationId === undefined ? INSTALLATION_ID : options.installationId;
    },
    revokeDeviceToken: async installationId => {
      calls.push('revoke');
      revokedInstallations.push(installationId);
      if (options.revokeThrows) throw new Error('network');
      return { error: options.revokeError ?? null };
    },
    endSession: async () => {
      calls.push('signOut');
      if (options.sessionThrows) throw new Error('network');
      return { error: options.sessionError ?? null };
    },
  };
  return { deps, calls, revokedInstallations };
}

test('إلغاء رمز الجهاز يسبق إنهاء الجلسة', async () => {
  const { deps, calls, revokedInstallations } = createDeps();
  const outcome = await signOutThisDevice(deps);

  assert.deepEqual(calls, ['readUserId', 'readInstallationId', 'revoke', 'signOut']);
  assert.equal(calls.indexOf('revoke') < calls.indexOf('signOut'), true);
  assert.deepEqual(revokedInstallations, [INSTALLATION_ID]);
  assert.deepEqual(outcome, {
    ok: true,
    revoked: true,
    message: PUSH_SIGN_OUT_DONE_WITH_DEVICE_MESSAGE,
  });
});

test('فشل الإلغاء لا ينهي الجلسة ولا يُعرض كنجاح', async () => {
  const { deps, calls } = createDeps({ revokeError: { code: 'network_request_failed' } });
  const outcome = await signOutThisDevice(deps);

  assert.deepEqual(outcome, {
    ok: false,
    step: 'revoke',
    message: PUSH_SIGN_OUT_REVOKE_FAILED_MESSAGE,
  });
  assert.equal(calls.includes('signOut'), false);
});

test('انقطاع يرمي استثناءً في الإلغاء يُعامل كفشل', async () => {
  const { deps, calls } = createDeps({ revokeThrows: true });
  const outcome = await signOutThisDevice(deps);

  assert.deepEqual(outcome, {
    ok: false,
    step: 'revoke',
    message: PUSH_SIGN_OUT_REVOKE_FAILED_MESSAGE,
  });
  assert.equal(calls.includes('signOut'), false);
});

test('فشل إنهاء الجلسة بعد إلغاء ناجح يُبلَّغ عنه ولا يُخفي الإلغاء', async () => {
  const { deps, calls } = createDeps({ sessionError: { code: 'network_request_failed' } });
  const outcome = await signOutThisDevice(deps);

  assert.deepEqual(outcome, {
    ok: false,
    step: 'session',
    message: PUSH_SIGN_OUT_SESSION_FAILED_MESSAGE,
  });
  assert.deepEqual(calls, ['readUserId', 'readInstallationId', 'revoke', 'signOut']);
});

test('انقطاع في إنهاء الجلسة يُعامل كفشل لا كنجاح', async () => {
  const { deps } = createDeps({ sessionThrows: true });
  assert.deepEqual(await signOutThisDevice(deps), {
    ok: false,
    step: 'session',
    message: PUSH_SIGN_OUT_SESSION_FAILED_MESSAGE,
  });
});

test('تعذّر التحقق من الجلسة: لا إلغاء ولا إنهاء ولا نجاح', async () => {
  const calls: string[] = [];
  const outcome = await signOutThisDevice({
    readUserId: async () => {
      calls.push('readUserId');
      throw new Error('getUser failed');
    },
    readInstallationId: () => {
      calls.push('readInstallationId');
      return INSTALLATION_ID;
    },
    revokeDeviceToken: async () => {
      calls.push('revoke');
      return { error: null };
    },
    endSession: async () => {
      calls.push('signOut');
      return { error: null };
    },
  });

  assert.deepEqual(outcome, {
    ok: false,
    step: 'session',
    message: PUSH_SIGN_OUT_SESSION_CHECK_FAILED_MESSAGE,
  });
  assert.deepEqual(calls, ['readUserId']);
});

test('بلا جلسة أو بلا جهاز مسجّل: لا إلغاء، وإنهاء الجلسة وحده', async () => {
  const noSession = createDeps({ userId: null });
  assert.deepEqual(await signOutThisDevice(noSession.deps), {
    ok: true,
    revoked: false,
    message: PUSH_SIGN_OUT_DONE_WITHOUT_DEVICE_MESSAGE,
  });
  assert.deepEqual(noSession.calls, ['readUserId', 'readInstallationId', 'signOut']);

  const noDevice = createDeps({ installationId: null });
  assert.deepEqual(await signOutThisDevice(noDevice.deps), {
    ok: true,
    revoked: false,
    message: PUSH_SIGN_OUT_DONE_WITHOUT_DEVICE_MESSAGE,
  });
  assert.deepEqual(noDevice.calls, ['readUserId', 'readInstallationId', 'signOut']);
});

test('الدالة غير منشورة في القاعدة: لا شيء يُلغى والخروج يكتمل', async () => {
  const calls: string[] = [];
  const outcome = await signOutThisDevice({
    readUserId: async () => {
      calls.push('readUserId');
      return USER_ID;
    },
    readInstallationId: () => {
      calls.push('readInstallationId');
      return INSTALLATION_ID;
    },
    revokeDeviceToken: async () => {
      calls.push('revoke');
      return { error: null, missing: true };
    },
    endSession: async () => {
      calls.push('signOut');
      return { error: null };
    },
  });

  assert.deepEqual(outcome, {
    ok: true,
    revoked: false,
    message: PUSH_SIGN_OUT_DONE_WITHOUT_DEVICE_MESSAGE,
  });
  assert.deepEqual(calls, ['readUserId', 'readInstallationId', 'revoke', 'signOut']);
});

test('الإلغاء بمعرّف التثبيت وحده: لا رمز ولا معرّف صف آخر', async () => {
  const { deps, revokedInstallations } = createDeps();
  assert.equal(deps.revokeDeviceToken.length, 1);
  await signOutThisDevice(deps);
  assert.deepEqual(revokedInstallations, [INSTALLATION_ID]);

  const moduleSource = readFileSync(join(SRC_ROOT, 'lib/pushSignOut.ts'), 'utf8');
  assert.equal(/p_token|p_id\b|device_token_id/.test(moduleSource), false);
});

test('حذف الحساب: إنهاء الجلسة وحدها بلا إلغاء مكرر', async () => {
  const calls: string[] = [];
  const ended = await endSessionAfterAccountDeletion({
    endSession: async () => {
      calls.push('signOut');
      return { error: null };
    },
  });
  assert.deepEqual(ended, { ok: true, message: '' });
  assert.deepEqual(calls, ['signOut']);

  const failed = await endSessionAfterAccountDeletion({ endSession: async () => ({ error: { code: 'x' } }) });
  assert.deepEqual(failed, { ok: false, message: PUSH_SIGN_OUT_SESSION_FAILED_MESSAGE });
});

test('تسجيل الخروج المركزي يمرّ بالإلغاء قبل الجلسة', () => {
  const session = readFileSync(join(SRC_ROOT, 'hooks/useAppSession.ts'), 'utf8');
  assert.equal(session.includes('signOutThisDevice('), true);
  assert.equal(session.includes('deviceSignOutDeps('), true);
  // القوالب تُبنى قبل إنهاء الجلسة: الإلغاء داخلها يسبق auth.signOut.
  assert.equal(
    session.indexOf('deviceSignOutDeps(') < session.indexOf('auth.signOut('),
    true,
    'the device revocation must be wired before the session is ended',
  );
});

test('لا كتابة على profiles.fcm_token بعد الآن', () => {
  const shell = readFileSync(join(SRC_ROOT, 'components/shell/Shell.tsx'), 'utf8');
  assert.equal(shell.includes('fcm_token'), false);

  const push = readFileSync(join(SRC_ROOT, 'lib/pushNotifications.ts'), 'utf8');
  assert.equal(/from\('profiles'\)/.test(push), false);
});

test('كل مسارات الخروج المحلي تمرّ بإلغاء رمز هذا الجهاز', () => {
  const profile = readFileSync(join(SRC_ROOT, 'pages/ProfilePage.tsx'), 'utf8');
  assert.equal((profile.match(/signOutThisDevice\(/g) || []).length >= 2, true);

  const panel = readFileSync(join(SRC_ROOT, 'components/account/AccountSettingsPanel.tsx'), 'utf8');
  assert.equal(panel.includes('signOutThisDevice('), true);
});

test('الخروج من الأجهزة الأخرى لا يلمس رموز الأجهزة', () => {
  const sessions = readFileSync(join(SRC_ROOT, 'lib/accountSessions.ts'), 'utf8');
  assert.equal(/aani_revoke_device_token|device_tokens|revokeDeviceToken/.test(sessions), false);
});

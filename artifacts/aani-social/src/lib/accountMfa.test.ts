import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MFA_CODE_INVALID_MESSAGE,
  MFA_SESSION_MESSAGE,
  MFA_UNAVAILABLE_MESSAGE,
  confirmTotpEnrollment,
  disableTotp,
  readMfaStatus,
  resolveMfaGate,
  startTotpEnrollment,
  totpFactors,
  verifiedTotpFactors,
  type MfaClient,
  type MfaFactor,
} from './accountMfa';

const VERIFIED: MfaFactor = {
  id: 'factor-1',
  factorType: 'totp',
  status: 'verified',
  friendlyName: 'Aani',
  createdAt: '2026-01-01T00:00:00Z',
};
const UNVERIFIED: MfaFactor = { ...VERIFIED, id: 'factor-2', status: 'unverified' };
const SMS: MfaFactor = { ...VERIFIED, id: 'factor-3', factorType: 'sms' };

type Options = {
  calls?: string[];
  enrollError?: unknown;
  enrollData?: unknown;
  challengeError?: unknown;
  verifyError?: unknown;
  verifyTokens?: unknown;
  unenrollError?: unknown;
  sessionError?: unknown;
  syncOk?: boolean;
  syncEnabled?: boolean;
};

function createClient(options: Options = {}): MfaClient {
  const calls = options.calls ?? [];
  return {
    enroll: async payload => {
      calls.push(`enroll:${payload.factorType}:${payload.friendlyName}`);
      return {
        data: (options.enrollData ?? {
          id: 'factor-new',
          totp: { qr_code: 'data:image/svg+xml;base64,AAA', secret: 'JBSWY3DPEHPK3PXP' },
        }) as never,
        error: options.enrollError ?? null,
      } as never;
    },
    challenge: async payload => {
      calls.push(`challenge:${payload.factorId}`);
      return {
        data: options.challengeError ? null : { id: 'challenge-1' },
        error: options.challengeError ?? null,
      } as never;
    },
    verify: async payload => {
      calls.push(`verify:${payload.factorId}:${payload.challengeId}:${payload.code}`);
      return {
        data: (options.verifyTokens ?? (options.verifyError
          ? null
          : { access_token: 'aal2-access', refresh_token: 'aal2-refresh' })) as never,
        error: options.verifyError ?? null,
      } as never;
    },
    unenroll: async payload => {
      calls.push(`unenroll:${payload.factorId}`);
      return { data: {}, error: options.unenrollError ?? null } as never;
    },
    setSession: async tokens => {
      calls.push(`setSession:${tokens.access_token}`);
      return { error: options.sessionError ?? null };
    },
    syncServerState: async accessToken => {
      calls.push(`sync:${accessToken}`);
      if (options.syncOk === false) return { ok: false, message: 'تعذر تحديث حالة MFA.' };
      return { ok: true, mfaEnabled: options.syncEnabled ?? true };
    },
  };
}

test('only a verified TOTP factor counts', () => {
  assert.deepEqual(totpFactors([VERIFIED, SMS]).map(factor => factor.id), ['factor-1']);
  assert.deepEqual(verifiedTotpFactors([VERIFIED, UNVERIFIED, SMS]).map(factor => factor.id), ['factor-1']);
  assert.deepEqual(verifiedTotpFactors([]), []);
});

test('a user without MFA keeps the normal login', () => {
  assert.deepEqual(resolveMfaGate({ enabled: false, level: 'aal1', factors: [] }), { allow: true });
});

test('an MFA user at aal1 is refused until the TOTP challenge passes', () => {
  const gate = resolveMfaGate({ enabled: true, level: 'aal1', factors: [VERIFIED] });
  assert.equal(gate.allow, false);
  if (gate.allow) return;
  assert.equal(gate.reason, 'challenge');
});

test('an MFA user at aal2 with a verified factor is allowed', () => {
  assert.deepEqual(resolveMfaGate({ enabled: true, level: 'aal2', factors: [VERIFIED] }), { allow: true });
});

test('MFA enabled without a verified factor fails closed', () => {
  const gate = resolveMfaGate({ enabled: true, level: 'aal2', factors: [UNVERIFIED] });
  assert.equal(gate.allow, false);
  if (gate.allow) return;
  assert.equal(gate.reason, 'enroll');
});

test('the status separates enabled, level and verified factors', () => {
  assert.deepEqual(readMfaStatus({ enabled: true, level: 'aal1', factors: [VERIFIED] }), {
    enabled: true,
    level: 'aal1',
    verifiedCount: 1,
    factors: [VERIFIED],
    needsChallenge: true,
  });
  assert.equal(readMfaStatus({ enabled: false, level: 'aal1', factors: [] }).needsChallenge, false);
});

test('starting an enrollment returns the QR and the secret for the enrollment screen only', async () => {
  const calls: string[] = [];
  const result = await startTotpEnrollment(createClient({ calls }), 'Aani');

  assert.deepEqual(calls, ['enroll:totp:Aani']);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.enrollment.factorId, 'factor-new');
  assert.match(result.enrollment.qrCode, /^data:/);
  assert.equal(result.enrollment.secret, 'JBSWY3DPEHPK3PXP');
});

test('an enrollment without a QR or secret is not offered to the user', async () => {
  const result = await startTotpEnrollment(createClient({ enrollData: { id: 'factor-new', totp: {} } }));
  assert.deepEqual(result, { ok: false, message: MFA_UNAVAILABLE_MESSAGE });

  const failed = await startTotpEnrollment(createClient({ enrollError: { message: 'boom' } }));
  assert.deepEqual(failed, { ok: false, message: MFA_UNAVAILABLE_MESSAGE });
});

test('a wrong code never verifies, never sets a session and never syncs the server', async () => {
  const calls: string[] = [];
  const result = await confirmTotpEnrollment(createClient({ calls, verifyError: { message: 'invalid' } }), 'factor-new', '123456');

  assert.deepEqual(result, { ok: false, message: MFA_CODE_INVALID_MESSAGE });
  assert.deepEqual(calls, ['challenge:factor-new', 'verify:factor-new:challenge-1:123456']);
});

test('a malformed code is refused before any call', async () => {
  const calls: string[] = [];
  const result = await confirmTotpEnrollment(createClient({ calls }), 'factor-new', '12ab');
  assert.deepEqual(result, { ok: false, message: MFA_CODE_INVALID_MESSAGE });
  assert.deepEqual(calls, []);
});

test('a successful enrollment sets the aal2 session then syncs app_metadata on the server', async () => {
  const calls: string[] = [];
  const result = await confirmTotpEnrollment(createClient({ calls }), 'factor-new', '123456');

  assert.deepEqual(result, { ok: true, mfaEnabled: true });
  assert.deepEqual(calls, [
    'challenge:factor-new',
    'verify:factor-new:challenge-1:123456',
    'setSession:aal2-access',
    'sync:aal2-access',
  ]);
});

test('a failed session install or a failed server sync never reports the factor as verified', async () => {
  const sessionFailure = await confirmTotpEnrollment(
    createClient({ sessionError: { message: 'no session' } }),
    'factor-new',
    '123456',
  );
  assert.deepEqual(sessionFailure, { ok: false, message: MFA_SESSION_MESSAGE });

  const syncFailure = await confirmTotpEnrollment(
    createClient({ syncOk: false }),
    'factor-new',
    '123456',
  );
  assert.deepEqual(syncFailure, { ok: false, message: 'تعذر تحديث حالة MFA.' });
});

test('disabling requires a code, then unenrolls and syncs the server state', async () => {
  const calls: string[] = [];
  const result = await disableTotp(createClient({ calls, syncEnabled: false }), 'factor-1', '654321');

  assert.deepEqual(result, { ok: true, mfaEnabled: false });
  assert.deepEqual(calls, [
    'challenge:factor-1',
    'verify:factor-1:challenge-1:654321',
    'unenroll:factor-1',
    'setSession:aal2-access',
    'sync:aal2-access',
  ]);
});

test('disabling with a wrong code never unenrolls the factor', async () => {
  const calls: string[] = [];
  const result = await disableTotp(createClient({ calls, verifyError: { message: 'invalid' } }), 'factor-1', '000000');

  assert.deepEqual(result, { ok: false, message: MFA_CODE_INVALID_MESSAGE });
  assert.equal(calls.includes('unenroll:factor-1'), false);
});

test('a failed unenroll keeps the factor and reports failure', async () => {
  const result = await disableTotp(createClient({ unenrollError: { message: 'boom' } }), 'factor-1', '654321');
  assert.deepEqual(result, { ok: false, message: MFA_UNAVAILABLE_MESSAGE });
});

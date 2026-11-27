import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PHONE_LOGIN_FAILED_MESSAGE, type PhoneLoginResult } from './accountPhoneAlias';
import {
  completePhoneLogin,
  PHONE_LOGIN_CAPTCHA_REQUIRED_MESSAGE,
  PHONE_LOGIN_SESSION_FAILED_MESSAGE,
  type PhoneLoginSessionDeps,
} from './phoneLoginSession';

const PHONE = '+9647701234567';
const PASSWORD = 'correct horse battery';
const CAPTCHA = 'turnstile-token';
const USER_ID = 'user-1';

type DepsOptions = {
  calls?: string[];
  login?: () => Promise<PhoneLoginResult>;
  sessionError?: unknown;
  user?: { id?: string } | null;
  userError?: unknown;
};

function createDeps(options: DepsOptions = {}): PhoneLoginSessionDeps {
  const calls = options.calls ?? [];
  return {
    login: async (phone, password, captchaToken) => {
      calls.push(`login:${phone}:${captchaToken}`);
      if (options.login) return await options.login();
      void password;
      return { ok: true, accessToken: 'access', refreshToken: 'refresh' };
    },
    setSession: async tokens => {
      calls.push(`setSession:${tokens.accessToken}:${tokens.refreshToken}`);
      return { error: options.sessionError ?? null };
    },
    getUser: async () => {
      calls.push('getUser');
      return {
        data: { user: options.user === undefined ? { id: USER_ID } : options.user },
        error: options.userError ?? null,
      };
    },
    signOutLocal: async () => {
      calls.push('signOutLocal');
      return undefined;
    },
  };
}

test('the phone route logs in through the function, then sets the session and verifies the user', async () => {
  const calls: string[] = [];
  const result = await completePhoneLogin(PHONE, PASSWORD, CAPTCHA, createDeps({ calls }));

  assert.deepEqual(result, { ok: true, userId: USER_ID });
  assert.deepEqual(calls, [
    `login:${PHONE}:${CAPTCHA}`,
    'setSession:access:refresh',
    'getUser',
  ]);
});

test('no phone request starts without a captcha token', async () => {
  const calls: string[] = [];
  const result = await completePhoneLogin(PHONE, PASSWORD, '', createDeps({ calls }));

  assert.deepEqual(result, { ok: false, message: PHONE_LOGIN_CAPTCHA_REQUIRED_MESSAGE });
  assert.deepEqual(calls, []);
});

test('a failed phone login never sets a session', async () => {
  const calls: string[] = [];
  const result = await completePhoneLogin(PHONE, PASSWORD, CAPTCHA, createDeps({
    calls,
    login: async () => ({ ok: false, message: PHONE_LOGIN_FAILED_MESSAGE }),
  }));

  assert.deepEqual(result, { ok: false, message: PHONE_LOGIN_FAILED_MESSAGE });
  assert.deepEqual(calls, [`login:${PHONE}:${CAPTCHA}`]);
});

test('a failed session install never verifies or navigates', async () => {
  const calls: string[] = [];
  const result = await completePhoneLogin(PHONE, PASSWORD, CAPTCHA, createDeps({
    calls,
    sessionError: { message: 'set session failed' },
  }));

  assert.deepEqual(result, { ok: false, message: PHONE_LOGIN_SESSION_FAILED_MESSAGE });
  assert.deepEqual(calls, [
    `login:${PHONE}:${CAPTCHA}`,
    'setSession:access:refresh',
  ]);
});

test('a failed user verification cancels the local session', async () => {
  const missingUser = await completePhoneLogin(PHONE, PASSWORD, CAPTCHA, createDeps({ user: null }));
  assert.deepEqual(missingUser, { ok: false, message: PHONE_LOGIN_SESSION_FAILED_MESSAGE });

  const calls: string[] = [];
  const errorResult = await completePhoneLogin(PHONE, PASSWORD, CAPTCHA, createDeps({
    calls,
    userError: { message: 'getUser failed' },
  }));
  assert.deepEqual(errorResult, { ok: false, message: PHONE_LOGIN_SESSION_FAILED_MESSAGE });
  assert.equal(calls.includes('signOutLocal'), true);
});

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));
const authPage = readFileSync(join(SRC_ROOT, 'pages/AuthPage.tsx'), 'utf8');
const sessionModule = readFileSync(join(SRC_ROOT, 'lib/phoneLoginSession.ts'), 'utf8');

test('the phone path calls login-with-phone only, never signInWithPassword with a phone', () => {
  for (const [name, source] of [['AuthPage.tsx', authPage], ['phoneLoginSession.ts', sessionModule]]) {
    assert.equal(/signInWithPassword\s*\(\s*\{\s*phone/i.test(source), false, `${name} must not sign in with a phone`);
  }
  assert.equal(authPage.includes('loginWithPhone('), true);
  assert.equal(authPage.includes('completePhoneLogin('), true);
  assert.equal(authPage.includes('invokePhoneLogin'), true);
});

test('the email, username, Google and Apple paths are unchanged', () => {
  assert.equal(authPage.includes("signInWithPassword({\n          email: parsed.email"), true);
  assert.equal(authPage.includes("'login-with-username'"), true);
  assert.equal(authPage.includes('useOAuthProvider'), true);
  assert.equal(authPage.includes('signInWithProvider'), true);
  const oauthProvider = readFileSync(join(SRC_ROOT, 'lib/oauthProvider.ts'), 'utf8');
  assert.equal(oauthProvider.includes('signInWithOAuth'), true);
  assert.equal(oauthProvider.includes("'google'") || oauthProvider.includes('"google"'), true);
  assert.equal(oauthProvider.includes("'apple'") || oauthProvider.includes('"apple"'), true);
  assert.equal(authPage.includes('supabase.auth.signUp('), true);
});

test('no password or session token is logged or stored locally', () => {
  for (const [name, source] of [['AuthPage.tsx', authPage], ['phoneLoginSession.ts', sessionModule]]) {
    assert.equal(/localStorage|sessionStorage/.test(source), false, `${name} must not use local storage`);
    for (const line of source.split('\n')) {
      if (/console\./.test(line)) {
        assert.equal(/password|access_token|refresh_token|accessToken|refreshToken/i.test(line), false, `${name} must not log secrets`);
      }
    }
  }
  assert.equal(/console\./.test(sessionModule), false, 'the session module must not log anything');
});

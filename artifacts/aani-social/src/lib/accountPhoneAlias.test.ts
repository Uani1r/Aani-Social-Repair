import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACCOUNT_PHONE_ALIAS_FUNCTION,
  PHONE_ALIAS_INVALID_MESSAGE,
  PHONE_ALIAS_TAKEN_MESSAGE,
  PHONE_LOGIN_FAILED_MESSAGE,
  PHONE_LOGIN_FUNCTION,
  PHONE_LOGIN_RATE_LIMITED_MESSAGE,
  createPhoneFunctionInvoker,
  deletePhoneAlias,
  loadPhoneAlias,
  loginWithPhone,
  readPhoneAliasPayload,
  savePhoneAlias,
  type PhoneFunctionInvoker,
  type PhoneInvokeResult,
} from './accountPhoneAlias';

const LOCAL_PHONE = '07701234567';
const NEW_PHONE = '+9647701234567';
const OTHER_PHONE = '+9647709876543';
const PASSWORD = 'correct horse battery';

type Call = { name: string; body: Record<string, unknown> };

function fakeInvoker(handler: (call: Call) => PhoneInvokeResult | Promise<PhoneInvokeResult>) {
  const calls: Call[] = [];
  const invoke: PhoneFunctionInvoker = async (name, body) => {
    const call = { name, body };
    calls.push(call);
    return handler(call);
  };
  return { invoke, calls };
}

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

function readSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      readSourceFiles(full, files);
      continue;
    }
    if (['.ts', '.tsx', '.js', '.jsx'].includes(extname(full)) && !full.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

test('a local Iraqi number is saved as E.164 without any SMS step', async () => {
  const { invoke, calls } = fakeInvoker(() => ({ ok: true, data: { phone: NEW_PHONE } }));

  const result = await savePhoneAlias(LOCAL_PHONE, invoke);

  assert.deepEqual(result, { ok: true, phone: NEW_PHONE });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, ACCOUNT_PHONE_ALIAS_FUNCTION);
  assert.deepEqual(calls[0].body, { action: 'set', phone: NEW_PHONE });
});

test('an international number is accepted and normalised', async () => {
  const withPlus = fakeInvoker(() => ({ ok: true, data: { phone: NEW_PHONE } }));
  await savePhoneAlias('+964 770 123 4567', withPlus.invoke);
  assert.deepEqual(withPlus.calls[0].body, { action: 'set', phone: NEW_PHONE });

  const withZeroes = fakeInvoker(() => ({ ok: true, data: { phone: NEW_PHONE } }));
  await savePhoneAlias('009647701234567', withZeroes.invoke);
  assert.deepEqual(withZeroes.calls[0].body, { action: 'set', phone: NEW_PHONE });
});

test('an invalid number is rejected before any server call', async () => {
  const { invoke, calls } = fakeInvoker(() => ({ ok: true, data: { phone: NEW_PHONE } }));

  const result = await savePhoneAlias('12', invoke);

  assert.deepEqual(result, { ok: false, message: PHONE_ALIAS_INVALID_MESSAGE });
  assert.equal(calls.length, 0);
});

test('a number taken by another account is refused with one clear message and no other account data', async () => {
  const { invoke } = fakeInvoker(() => ({ ok: false, status: 409, message: 'phone_taken' }));

  const result = await savePhoneAlias(OTHER_PHONE, invoke);

  assert.deepEqual(result, { ok: false, message: PHONE_ALIAS_TAKEN_MESSAGE });
  assert.equal(Object.keys(result).includes('phone'), false);
});

test('a failed change keeps the previous number, and a save is one atomic request', async () => {
  let displayed = OTHER_PHONE;
  const { invoke, calls } = fakeInvoker(() => ({ ok: false, status: 409, message: 'taken' }));

  const result = await savePhoneAlias(NEW_PHONE, invoke);
  if (result.ok) displayed = result.phone;

  assert.equal(displayed, OTHER_PHONE);
  // طلب واحد فقط: لا قراءة ثم كتابة، فلا نافذة لمنافسة أخرى.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { action: 'set', phone: NEW_PHONE });
});

test('deleting the alias calls the delete action for the session account only', async () => {
  const { invoke, calls } = fakeInvoker(() => ({ ok: true, data: { phone: null } }));

  assert.deepEqual(await deletePhoneAlias(invoke), { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { action: 'delete' });
});

test('no request carries a user id from the client', async () => {
  const save = fakeInvoker(() => ({ ok: true, data: { phone: NEW_PHONE } }));
  await savePhoneAlias(LOCAL_PHONE, save.invoke);
  assert.deepEqual(Object.keys(save.calls[0].body).sort(), ['action', 'phone']);

  const remove = fakeInvoker(() => ({ ok: true, data: { phone: null } }));
  await deletePhoneAlias(remove.invoke);
  assert.deepEqual(Object.keys(remove.calls[0].body).sort(), ['action']);

  const login = fakeInvoker(() => ({
    ok: true,
    data: { access_token: 'access', refresh_token: 'refresh', user: { email: 'someone@example.com' } },
  }));
  await loginWithPhone(LOCAL_PHONE, PASSWORD, login.invoke);
  assert.deepEqual(Object.keys(login.calls[0].body).sort(), ['password', 'phone']);
});

test('the alias read returns the phone for the session account', async () => {
  const present = fakeInvoker(() => ({ ok: true, data: { phone: NEW_PHONE } }));
  assert.deepEqual(await loadPhoneAlias(present.invoke), { status: 'present', phone: NEW_PHONE });
  assert.deepEqual(present.calls[0].body, { action: 'read' });

  const absent = fakeInvoker(() => ({ ok: true, data: { phone: null } }));
  assert.deepEqual(await loadPhoneAlias(absent.invoke), { status: 'absent' });
});

test('an unreadable alias read is not reported as no number', () => {
  assert.equal(readPhoneAliasPayload(null).status, 'unavailable');
  assert.equal(readPhoneAliasPayload({ phone: '07701234567' }).status, 'unavailable');
  assert.deepEqual(readPhoneAliasPayload({ phone: null }), { status: 'absent' });
});

test('a correct number and password return a session', async () => {
  const { invoke, calls } = fakeInvoker(() => ({
    ok: true,
    data: { access_token: 'access-token', refresh_token: 'refresh-token', token_type: 'bearer' },
  }));

  const result = await loginWithPhone(LOCAL_PHONE, PASSWORD, invoke);

  assert.deepEqual(result, { ok: true, accessToken: 'access-token', refreshToken: 'refresh-token' });
  assert.equal(calls[0].name, PHONE_LOGIN_FUNCTION);
  assert.deepEqual(calls[0].body, { phone: NEW_PHONE, password: PASSWORD });
});

test('a wrong password fails with the generic message', async () => {
  const { invoke } = fakeInvoker(() => ({ ok: false, status: 401, message: PHONE_LOGIN_FAILED_MESSAGE }));
  assert.deepEqual(
    await loginWithPhone(LOCAL_PHONE, 'wrong password', invoke),
    { ok: false, message: PHONE_LOGIN_FAILED_MESSAGE },
  );
});

test('a number with no account fails with the very same message as a wrong password', async () => {
  const wrongPassword = fakeInvoker(() => ({ ok: false, status: 401, message: 'whatever the server says' }));
  const unknownNumber = fakeInvoker(() => ({ ok: false, status: 401, message: 'another message' }));

  const first = await loginWithPhone(NEW_PHONE, PASSWORD, wrongPassword.invoke);
  const second = await loginWithPhone(OTHER_PHONE, PASSWORD, unknownNumber.invoke);

  assert.deepEqual(first, second);
  assert.deepEqual(first, { ok: false, message: PHONE_LOGIN_FAILED_MESSAGE });
});

test('a failed login never returns a session', async () => {
  const { invoke } = fakeInvoker(() => ({ ok: false, status: 401, message: 'invalid' }));
  const result = await loginWithPhone(NEW_PHONE, PASSWORD, invoke);
  assert.equal(result.ok, false);
  assert.equal(Object.keys(result).includes('accessToken'), false);
  assert.equal(Object.keys(result).includes('refreshToken'), false);

  const incomplete = fakeInvoker(() => ({ ok: true, data: { access_token: 'only' } }));
  assert.deepEqual(
    await loginWithPhone(NEW_PHONE, PASSWORD, incomplete.invoke),
    { ok: false, message: PHONE_LOGIN_FAILED_MESSAGE },
  );
});

test('a login success exposes the tokens only, never the account email or user object', async () => {
  const { invoke } = fakeInvoker(() => ({
    ok: true,
    data: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      user: { id: 'some-user', email: 'someone@example.com' },
      email: 'someone@example.com',
    },
  }));

  const result = await loginWithPhone(NEW_PHONE, PASSWORD, invoke);

  assert.deepEqual(Object.keys(result).sort(), ['accessToken', 'ok', 'refreshToken']);
  assert.equal(JSON.stringify(result).includes('@'), false);
  assert.equal(JSON.stringify(result).includes('some-user'), false);
});

test('a rate-limited login is told apart without revealing anything about the number', async () => {
  const { invoke } = fakeInvoker(() => ({ ok: false, status: 429, message: 'rate' }));
  assert.deepEqual(
    await loginWithPhone(NEW_PHONE, PASSWORD, invoke),
    { ok: false, message: PHONE_LOGIN_RATE_LIMITED_MESSAGE, rateLimited: true },
  );
});

test('the invoker turns a function error into the status and the Arabic message', async () => {
  const invoker = createPhoneFunctionInvoker({
    invoke: async () => ({
      data: null,
      error: Object.assign(new Error('Failed to send a request'), {
        context: new Response(JSON.stringify({ error: PHONE_ALIAS_TAKEN_MESSAGE }), { status: 409 }),
      }),
    }),
  });

  assert.deepEqual(
    await invoker(ACCOUNT_PHONE_ALIAS_FUNCTION, { action: 'set', phone: NEW_PHONE }),
    { ok: false, status: 409, message: PHONE_ALIAS_TAKEN_MESSAGE },
  );
});

test('the client never reads or writes the alias table directly', () => {
  const offenders = readSourceFiles(SRC_ROOT).filter(file => {
    const source = readFileSync(file, 'utf8');
    return /\.from\(\s*['"`]account_phone_aliases|rest\/v1\/account_phone_aliases/.test(source);
  });
  assert.deepEqual(offenders, []);
});

test('no phone path uses SMS, OTP or auth.users.phone', () => {
  const offenders = readSourceFiles(SRC_ROOT).filter(file => {
    const source = readFileSync(file, 'utf8');
    return /supabase\.auth\.verifyOtp|type:\s*['"]phone_change['"]|phone_confirm\s*:\s*true|supabase\.auth\.updateUser\s*\(\s*\{\s*phone\b/.test(source);
  });
  assert.deepEqual(offenders, []);
});

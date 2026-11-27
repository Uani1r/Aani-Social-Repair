import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCOUNT_EMAIL_INVALID_MESSAGE,
  ACCOUNT_EMAIL_LINK_EXPIRED_MESSAGE,
  ACCOUNT_EMAIL_RATE_LIMITED_MESSAGE,
  ACCOUNT_EMAIL_SAME_MESSAGE,
  ACCOUNT_EMAIL_TAKEN_MESSAGE,
  ACCOUNT_EMAIL_UNAVAILABLE_MESSAGE,
  describeEmailChangeState,
  planEmailChange,
  readEmailChangeFailure,
  requestEmailChange,
} from './accountEmailChange';

const CURRENT = 'someone@example.com';
const NEXT = 'Next.Person@Example.com';

test('a malformed or empty email is refused before any request', () => {
  for (const value of ['', '   ', 'someone', 'someone@', '@example.com', 'a b@example.com']) {
    assert.deepEqual(planEmailChange(CURRENT, value), {
      ok: false,
      message: ACCOUNT_EMAIL_INVALID_MESSAGE,
    }, value);
  }
});

test('the current email is refused as a no-op', () => {
  assert.deepEqual(planEmailChange(CURRENT, ' Someone@Example.com '), {
    ok: false,
    message: ACCOUNT_EMAIL_SAME_MESSAGE,
  });
});

test('a valid new email is normalised and accepted', () => {
  assert.deepEqual(planEmailChange(CURRENT, NEXT), { ok: true, email: 'next.person@example.com' });
});

test('an invalid email never reaches updateUser', async () => {
  const calls: string[] = [];
  const result = await requestEmailChange(CURRENT, 'not-an-email', {
    updateUser: async payload => {
      calls.push(payload.email);
      return { error: null };
    },
  });

  assert.deepEqual(result, { ok: false, message: ACCOUNT_EMAIL_INVALID_MESSAGE });
  assert.deepEqual(calls, []);
});

test('a request sends the normalised email and reports a pending confirmation', async () => {
  const calls: string[] = [];
  const result = await requestEmailChange(CURRENT, NEXT, {
    updateUser: async payload => {
      calls.push(payload.email);
      return { error: null };
    },
  });

  assert.deepEqual(calls, ['next.person@example.com']);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.pending, true);
  assert.equal(result.email, 'next.person@example.com');
  // البريد المعروض لا يتغيّر هنا: الرسالة تقول إن التغيير معلّق.
  assert.match(result.message, /لن يتغيّر|معلّق|تأكيد/);
});

test('server failures map to one general Arabic message each', () => {
  assert.equal(
    readEmailChangeFailure({ message: 'A user with this email address has already been registered' }),
    ACCOUNT_EMAIL_TAKEN_MESSAGE,
  );
  assert.equal(
    readEmailChangeFailure({ message: 'For security purposes, you can only request this after 41 seconds.' }),
    ACCOUNT_EMAIL_RATE_LIMITED_MESSAGE,
  );
  assert.equal(
    readEmailChangeFailure({ message: 'Email link is invalid or has expired' }),
    ACCOUNT_EMAIL_LINK_EXPIRED_MESSAGE,
  );
  assert.equal(
    readEmailChangeFailure({ message: 'Unable to validate email address: invalid format' }),
    ACCOUNT_EMAIL_INVALID_MESSAGE,
  );
  assert.equal(readEmailChangeFailure({ message: 'unexpected failure' }), ACCOUNT_EMAIL_UNAVAILABLE_MESSAGE);
  assert.equal(readEmailChangeFailure(null), ACCOUNT_EMAIL_UNAVAILABLE_MESSAGE);
});

test('a rejected request returns the mapped message and never reports success', async () => {
  const result = await requestEmailChange(CURRENT, NEXT, {
    updateUser: async () => ({ error: { message: 'email address already registered' } }),
  });

  assert.deepEqual(result, { ok: false, message: ACCOUNT_EMAIL_TAKEN_MESSAGE });
});

test('the pending state is shown apart from the confirmed email', () => {
  assert.deepEqual(describeEmailChangeState({ currentEmail: CURRENT, pendingEmail: NEXT }), {
    currentEmail: CURRENT,
    pendingEmail: NEXT,
    hasPending: true,
  });
  assert.deepEqual(describeEmailChangeState({ currentEmail: CURRENT, pendingEmail: null }), {
    currentEmail: CURRENT,
    pendingEmail: null,
    hasPending: false,
  });
  assert.deepEqual(describeEmailChangeState({ currentEmail: CURRENT, pendingEmail: CURRENT }), {
    currentEmail: CURRENT,
    pendingEmail: null,
    hasPending: false,
  });
});

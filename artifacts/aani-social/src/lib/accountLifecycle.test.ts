import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCOUNT_DEACTIVATED_MESSAGE,
  ACCOUNT_DEACTIVATION_FAILED_MESSAGE,
  ACCOUNT_DELETED_MESSAGE,
  ACCOUNT_DELETE_FAILED_MESSAGE,
  ACCOUNT_REACTIVATED_MESSAGE,
  deactivateAccount,
  deleteAccount,
  reactivateAccount,
} from './accountLifecycle';

test('a failed deactivation does not sign out the local session', async () => {
  const calls: string[] = [];
  const result = await deactivateAccount({
    deactivate: async () => {
      calls.push('deactivate');
      return { error: { message: 'boom' } };
    },
    signOutLocal: async () => {
      calls.push('signOut');
      return { error: null };
    },
  });

  assert.deepEqual(result, { ok: false, message: ACCOUNT_DEACTIVATION_FAILED_MESSAGE });
  assert.deepEqual(calls, ['deactivate'], 'the server decides first');
});

test('a successful deactivation then ends the local session and says so', async () => {
  const calls: string[] = [];
  const result = await deactivateAccount({
    deactivate: async () => {
      calls.push('deactivate');
      return { error: null };
    },
    signOutLocal: async () => {
      calls.push('signOut');
      return { error: null };
    },
  });

  assert.deepEqual(result, { ok: true, message: ACCOUNT_DEACTIVATED_MESSAGE });
  assert.deepEqual(calls, ['deactivate', 'signOut']);
});

test('reactivation is reported only after the server confirms it', async () => {
  assert.deepEqual(
    await reactivateAccount({ reactivate: async () => ({ error: { message: 'boom' } }) }),
    { ok: false, message: ACCOUNT_DEACTIVATION_FAILED_MESSAGE },
  );
  assert.deepEqual(
    await reactivateAccount({ reactivate: async () => ({ error: null }) }),
    { ok: true, message: ACCOUNT_REACTIVATED_MESSAGE },
  );
});

test('deletion requires the confirmation word and never calls the server without it', async () => {
  const calls: string[] = [];
  const result = await deleteAccount('', {
    deleteAccount: async () => {
      calls.push('delete');
      return { data: { success: true }, error: null };
    },
    signOutLocal: async () => {
      calls.push('signOut');
      return { error: null };
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
});

test('a server failure keeps the account and the session untouched', async () => {
  const calls: string[] = [];
  const result = await deleteAccount('حذف', {
    deleteAccount: async () => {
      calls.push('delete');
      return { data: null, error: { message: 'Failed to send a request to the Edge Function' } };
    },
    signOutLocal: async () => {
      calls.push('signOut');
      return { error: null };
    },
  });

  assert.deepEqual(result, { ok: false, message: ACCOUNT_DELETE_FAILED_MESSAGE });
  assert.deepEqual(calls, ['delete']);
});

test('a response without success is a failure, not a deletion', async () => {
  const calls: string[] = [];
  const result = await deleteAccount('حذف', {
    deleteAccount: async () => {
      calls.push('delete');
      return { data: { success: false }, error: null };
    },
    signOutLocal: async () => {
      calls.push('signOut');
      return { error: null };
    },
  });

  assert.deepEqual(result, { ok: false, message: ACCOUNT_DELETE_FAILED_MESSAGE });
  assert.equal(calls.includes('signOut'), false);
});

test('a confirmed deletion ends the local session and reports the queue message', async () => {
  const calls: string[] = [];
  const result = await deleteAccount('حذف', {
    deleteAccount: async () => {
      calls.push('delete');
      return { data: { success: true }, error: null };
    },
    signOutLocal: async () => {
      calls.push('signOut');
      return { error: null };
    },
  });

  assert.deepEqual(result, { ok: true, message: ACCOUNT_DELETED_MESSAGE });
  assert.deepEqual(calls, ['delete', 'signOut']);
  assert.equal(/طابور/.test(ACCOUNT_DELETED_MESSAGE), true);
});

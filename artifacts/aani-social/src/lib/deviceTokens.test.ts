import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEVICE_INSTALLATION_STORAGE_KEY,
  buildRegistrationInput,
  buildRevocationInput,
  describeDevice,
  detectDevicePlatform,
  readOrCreateInstallationId,
  validateRegistrationInput,
} from './deviceTokens';

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

test('المنصة تُكتشف من User-Agent الفعلي', () => {
  assert.equal(detectDevicePlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120'), 'android');
  assert.equal(detectDevicePlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'ios');
  assert.equal(detectDevicePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'web');
  assert.equal(detectDevicePlatform(''), 'web');
});

test('اسم الجهاز بلا معرّفات حساسة', () => {
  assert.equal(describeDevice('android'), 'Android');
  assert.equal(describeDevice('ios'), 'iOS');
  assert.equal(describeDevice('web'), 'متصفح');
});

test('معرّف التثبيت يُنشأ مرة واحدة ويُعاد استخدامه', () => {
  const storage = createStorage();
  const first = readOrCreateInstallationId(storage);
  const second = readOrCreateInstallationId(storage);

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(storage.values.get(DEVICE_INSTALLATION_STORAGE_KEY), first);
});

test('معرّف مخزّن غير صالح يُستبدل بمعرّف جديد صالح', () => {
  const storage = createStorage({ [DEVICE_INSTALLATION_STORAGE_KEY]: 'not-a-uuid' });
  const id = readOrCreateInstallationId(storage);
  assert.notEqual(id, 'not-a-uuid');
  assert.match(id, /^[0-9a-f-]{36}$/);
});

test('انعدام التخزين لا يمنع التسجيل', () => {
  const id = readOrCreateInstallationId(null);
  assert.match(id, /^[0-9a-f-]{36}$/);
});

test('بناء وسائط التسجيل: منصة ومزود ومعرّف تثبيت بلا أسرار', () => {
  const input = buildRegistrationInput({
    token: '  fcm-token-1  ',
    userAgent: 'Mozilla/5.0 (Linux; Android 14)',
    installationId: '11111111-1111-4111-a111-111111111111',
  });

  assert.equal(input.token, 'fcm-token-1');
  assert.equal(input.platform, 'android');
  assert.equal(input.provider, 'fcm');
  assert.equal(input.installationId, '11111111-1111-4111-a111-111111111111');
  assert.equal(input.deviceName, 'Android');
  assert.deepEqual(input.metadata, { app: 'aani-social', surface: 'web' });
});

test('التحقق يرفض الرمز الفارغ أو المنصة أو المزود غير المعروف', () => {
  assert.equal(validateRegistrationInput({ token: 't', platform: 'web', provider: 'fcm' }).ok, true);
  assert.equal(validateRegistrationInput({ token: '   ', platform: 'web', provider: 'fcm' }).ok, false);
  assert.equal(validateRegistrationInput({ token: 't', platform: 'windows', provider: 'fcm' }).ok, false);
  assert.equal(validateRegistrationInput({ token: 't', platform: 'web', provider: 'sms' }).ok, false);
  assert.equal(validateRegistrationInput({ token: 'x'.repeat(5000), platform: 'web', provider: 'fcm' }).ok, false);
});

test('إلغاء الجهاز يستخدم installation_id فقط ولا يحذف', () => {
  const input = buildRevocationInput({ installationId: '11111111-1111-4111-a111-111111111111' });
  assert.deepEqual(input, {
    p_installation_id: '11111111-1111-4111-a111-111111111111',
    p_token: null,
    p_id: null,
  });
});

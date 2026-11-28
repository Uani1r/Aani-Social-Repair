import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PUSH_MESSAGES,
  evaluatePushEnvironment,
  isIosBrowser,
  isStandaloneDisplay,
} from './pushNotifications';

/**
 * بيئة الإشعارات: على iPhone/iPad لا يُطلب إذن قبل التثبيت على الشاشة
 * الرئيسية، وبعد التثبيت يُسمح بالمتابعة. القرار هنا نقي وقابل للاختبار،
 * وواجهة PushNotificationsControl تتبعه.
 */

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPADOS_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BASE = {
  isIos: false,
  standalone: false,
  hasNotificationApi: true,
  hasServiceWorker: true,
  secureContext: true,
  permission: 'default' as const,
};

test('التعرف على iPhone وiPad وحدهما', () => {
  assert.equal(isIosBrowser(IPHONE), true);
  assert.equal(isIosBrowser(IPAD), true);
  assert.equal(isIosBrowser(ANDROID), false);
  assert.equal(isIosBrowser(MAC), false);
  assert.equal(isIosBrowser(''), false);
});

test('وضع standalone من iOS ومن display-mode', () => {
  assert.equal(isStandaloneDisplay({ navigatorStandalone: true }), true);
  assert.equal(isStandaloneDisplay({ displayModeStandalone: true }), true);
  assert.equal(isStandaloneDisplay({ navigatorStandalone: false, displayModeStandalone: false }), false);
  assert.equal(isStandaloneDisplay({ navigatorStandalone: 'yes', displayModeStandalone: 1 }), false);
});

test('iPhone قبل التثبيت: لا طلب إذن، وشرح الإضافة إلى الشاشة الرئيسية', () => {
  const result = evaluatePushEnvironment({ ...BASE, isIos: true, permission: 'default' });
  assert.equal(result.status, 'ios-install-required');
  assert.equal(result.canRequestPermission, false, 'permission must never be requested before installation');
  assert.equal(result.message, PUSH_MESSAGES.iosInstall);
  assert(result.message.includes('إضافة إلى الشاشة الرئيسية'), 'the instructions name the home-screen step');
});

test('iPhone قبل التثبيت يبقى غير جاهز حتى لو كان الإذن ممنوحاً', () => {
  const granted = evaluatePushEnvironment({ ...BASE, isIos: true, permission: 'granted' });
  assert.equal(granted.status, 'ios-install-required');
  assert.equal(granted.canRequestPermission, false);
  // والمعروف أن الممنوح قبل التثبيت لا يمنح تسجيلاً.
  const denied = evaluatePushEnvironment({ ...BASE, isIos: true, permission: 'denied' });
  assert.equal(denied.status, 'ios-install-required');
});

test('iPhone بعد التثبيت: متابعة الإذن ثم الجاهزية', () => {
  const needsPermission = evaluatePushEnvironment({
    ...BASE,
    isIos: true,
    standalone: true,
    permission: 'default',
  });
  assert.equal(needsPermission.status, 'needs-permission');
  assert.equal(needsPermission.canRequestPermission, true, 'an installed app may ask for permission');

  const ready = evaluatePushEnvironment({ ...BASE, isIos: true, standalone: true, permission: 'granted' });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.message, PUSH_MESSAGES.ready);
});

test('بقية المتصفحات: الجاهزية مرتبطة بالإذن فقط', () => {
  assert.equal(evaluatePushEnvironment({ ...BASE, permission: 'granted' }).status, 'ready');
  assert.equal(
    evaluatePushEnvironment({ ...BASE, permission: 'default' }).status,
    'needs-permission',
  );
  assert.equal(evaluatePushEnvironment({ ...BASE, permission: 'denied' }).status, 'denied');
  assert.equal(evaluatePushEnvironment({ ...BASE, permission: 'denied' }).canRequestPermission, false);
});

test('غير المدعوم وبلا HTTPS يُرفضان قبل أي طلب إذن', () => {
  assert.equal(evaluatePushEnvironment({ ...BASE, secureContext: false }).status, 'insecure');
  assert.equal(evaluatePushEnvironment({ ...BASE, hasNotificationApi: false }).status, 'unsupported');
  assert.equal(evaluatePushEnvironment({ ...BASE, hasServiceWorker: false }).status, 'unsupported');
  assert.equal(evaluatePushEnvironment({ ...BASE, permission: 'unsupported' }).status, 'unsupported');
  // حتى على iPhone بلا تثبيت: HTTPS يُفحص أولاً.
  assert.equal(
    evaluatePushEnvironment({ ...BASE, isIos: true, secureContext: false }).status,
    'insecure',
  );
});

test('كل حالة تحمل رسالة عربية غير فارغة', () => {
  for (const message of Object.values(PUSH_MESSAGES)) {
    assert.equal(typeof message === 'string' && message.trim().length > 0, true, String(message));
  }
  assert.equal(PUSH_MESSAGES.iosInstall.includes('Safari'), true, 'the iOS steps name Safari');
  assert.equal(PUSH_MESSAGES.denied.includes('محظورة'), true, 'a blocked permission has its own message');
});

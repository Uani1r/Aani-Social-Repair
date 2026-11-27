import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_MESSAGE_CALL_NOTIFICATION_TYPES,
  LEGACY_NOTIFICATION_TYPE_FILTER,
  countUnreadVisibleNotifications,
  isLegacyMessageCallNotification,
  isVisibleNotification,
  normalizeNotificationType,
  shouldHandleRealtimeNotification,
  visibleNotifications,
} from './notificationVisibility';

test('الأنواع القديمة المستبعدة هي أنواع الرسائل والمكالمات المثبتة في المخطط', () => {
  assert.deepEqual([...LEGACY_MESSAGE_CALL_NOTIFICATION_TYPES], [
    'message',
    'new_message',
    'chat_message',
    'call',
    'incoming_call',
    'missed_call',
  ]);
});

test('كل نوع قديم من الرسائل أو المكالمات يُستبعد', () => {
  for (const type of LEGACY_MESSAGE_CALL_NOTIFICATION_TYPES) {
    assert.equal(isLegacyMessageCallNotification(type), true, type);
    assert.equal(isVisibleNotification({ type }), false, type);
    assert.equal(shouldHandleRealtimeNotification(type), false, type);
  }
});

test('المقارنة تتجاهل حالة الأحرف والمسافات', () => {
  assert.equal(normalizeNotificationType('  MESSAGE '), 'message');
  assert.equal(isLegacyMessageCallNotification(' Incoming_Call '), true);
  assert.equal(isLegacyMessageCallNotification('MISSED_CALL'), true);
});

test('الإشعارات الاجتماعية لا تُستبعد', () => {
  const socialTypes = [
    'like',
    'comment',
    'reply',
    'mention',
    'repost',
    'follow',
    'followed',
    'new_follower',
    'started_following',
    'follow_request',
    'story',
    'story_like',
    'story_reply',
    'system',
  ];
  for (const type of socialTypes) {
    assert.equal(isLegacyMessageCallNotification(type), false, type);
    assert.equal(isVisibleNotification({ type }), true, type);
    assert.equal(shouldHandleRealtimeNotification(type), true, type);
  }
});

test('نوع مفقود أو غير نصي لا يُستبعد احتياطياً', () => {
  assert.equal(isVisibleNotification({}), true);
  assert.equal(isVisibleNotification(null), true);
  assert.equal(isVisibleNotification(undefined), true);
  assert.equal(isLegacyMessageCallNotification(null), false);
  assert.equal(isLegacyMessageCallNotification(42), false);
});

test('فلتر PostgREST يحتوي كل الأنواع القديمة بصيغة in', () => {
  assert.equal(LEGACY_NOTIFICATION_TYPE_FILTER.startsWith('('), true);
  assert.equal(LEGACY_NOTIFICATION_TYPE_FILTER.endsWith(')'), true);
  for (const type of LEGACY_MESSAGE_CALL_NOTIFICATION_TYPES) {
    assert.match(LEGACY_NOTIFICATION_TYPE_FILTER, new RegExp(`"${type}"`));
  }
});

test('صفوف القائمة تستبعد الرسائل والمكالمات القديمة وتبقي الاجتماعية', () => {
  const rows = [
    { id: '1', type: 'message', is_read: false },
    { id: '2', type: 'like', is_read: false },
    { id: '3', type: 'call', is_read: false },
    { id: '4', type: 'follow_request', is_read: true },
    { id: '5', type: 'missed_call', is_read: false },
    { id: '6', type: 'comment', is_read: true },
  ];

  assert.deepEqual(visibleNotifications(rows).map(row => row.id), ['2', '4', '6']);
});

test('عداد غير المقروء يستثني الأنواع القديمة', () => {
  const rows = [
    { id: '1', type: 'message', is_read: false },
    { id: '2', type: 'new_message', is_read: false },
    { id: '3', type: 'incoming_call', is_read: false },
    { id: '4', type: 'like', is_read: false },
    { id: '5', type: 'comment', is_read: false },
    { id: '6', type: 'follow', is_read: true },
    { id: '7', type: 'story_like', is_read: false },
  ];

  // ثلاثة غير مقروءة اجتماعية فقط: like وcomment وstory_like.
  assert.equal(countUnreadVisibleNotifications(rows), 3);
});

test('رسائل ومكالمات مقروءة لا تؤثر على العدّاد', () => {
  const rows = [
    { type: 'message', is_read: true },
    { type: 'call', is_read: false },
    { type: 'follow', is_read: false },
  ];
  assert.equal(countUnreadVisibleNotifications(rows), 1);
});

test('قائمة فارغة تعطي عدّاداً صفراً', () => {
  assert.equal(countUnreadVisibleNotifications([]), 0);
  assert.deepEqual(visibleNotifications([]), []);
});

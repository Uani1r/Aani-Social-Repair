// اختبارات مفتاح هوية الوسيط (mediaIdentityKey) — المقارنة بين روابط
// الصوت والفيديو في المعالجة الخادمية:
//   - نفس المسار مع اختلاف معاملات الاستعلام أو الهاشتاغ = الملف نفسه
//   - اختلاف المسار = ملفان مختلفان فعلاً
// الروابط الأصلية المخزنة لا تُعدَّل — المفتاح للمقارنة فقط.

import { test } from "node:test";
import assert from "node:assert/strict";

import { mediaIdentityKey } from "./mediaProcessing";

test('رابطان للمسار نفسه بمعاملات استعلام مختلفة = نفس الملف', () => {
  const plain = 'https://ik.imagekit.io/anisocial/aani/u1/video.mp4';
  // معاملات ImageKit التحويلية لا تغير الهوية — كانت تُفقد بالمسار القديم (stripFragment)
  assert.equal(
    mediaIdentityKey('https://ik.imagekit.io/anisocial/aani/u1/video.mp4?tr=w-400'),
    mediaIdentityKey(plain),
  );
  // تواقيع مؤقتة لا تغير الهوية
  assert.equal(
    mediaIdentityKey('https://ik.imagekit.io/anisocial/aani/u1/video.mp4?ik-s=aaa&ik-t=123'),
    mediaIdentityKey('https://ik.imagekit.io/anisocial/aani/u1/video.mp4?ik-s=bbb&ik-t=456'),
  );
});

test('رابطان للمسار نفسه بفرق هاشتاغ (#t= / #crop=) = نفس الملف', () => {
  // هذه الحالة كانت السبب في عدم عزل الصوت سابقاً: stripFragment وحده يزيل
  // الهاشتاغ لكن يترك اختلاف معاملات الاستعلام فجعل رابطين لنفس الملف مختلفين
  assert.equal(
    mediaIdentityKey('https://ik.imagekit.io/anisocial/aani/u1/video.mp4#t=0,15'),
    mediaIdentityKey('https://ik.imagekit.io/anisocial/aani/u1/video.mp4?tr=w-200#t=0,15'),
  );
});

test('مساران مختلفان = ملفان مختلفان حتى لو تطابقت المعاملات', () => {
  assert.notEqual(
    mediaIdentityKey('https://ik.imagekit.io/anisocial/aani/u1/a.mp4?tr=w-100'),
    mediaIdentityKey('https://ik.imagekit.io/anisocial/aani/u1/b.mp4?tr=w-100'),
  );
  // اختلاف المعرف في المسار يكفي
  assert.notEqual(
    mediaIdentityKey('https://ik.imagekit.io/anisocial/aani/u1/video-v1.mp4'),
    mediaIdentityKey('https://ik.imagekit.io/anisocial/aani/u1/video-v2.mp4'),
  );
});

test('روابط نسبية قديمة: يُزال التزخرف ويعاد المسار كما هو', () => {
  assert.equal(mediaIdentityKey('/aani/u1/x.mp4?tr=w-100'), '/aani/u1/x.mp4');
  assert.equal(mediaIdentityKey('/aani/u1/x.mp4#t=5'), '/aani/u1/x.mp4');
  // التطبيع الجديد يحسب اختلاف معاملات الروابط النسبية أيضاً (القديم كان يتركها)
  assert.notEqual(
    mediaIdentityKey('/aani/u1/x.mp4?ver=1'),
    mediaIdentityKey('/aani/u1/y.mp4?ver=1'),
  );
});

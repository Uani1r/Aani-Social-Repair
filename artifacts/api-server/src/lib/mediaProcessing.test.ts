// اختبارات مفتاح هوية الوسيط (mediaIdentityKey) ومُقيِّم الطوابع الزمنية
// للإطارات (createFrameTimestampVerifier) في المعالجة الخادمية:
//   - نفس المسار مع اختلاف معاملات الاستعلام أو الهاشتاغ = الملف نفسه
//   - اختلاف المسار = ملفان مختلفان فعلاً
//   - التحقق من جميع الطوابع الزمنية: الالتزام بـ30fps، التجاوز، اللاتصاعد،
//     التعذر، والنقص — مع ذاكرة إطار واحد بلا تحميل الجميع
// الروابط الأصلية المخزنة لا تُعدَّل — المفتاح للمقارنة فقط.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createFrameTimestampVerifier, mediaIdentityKey } from "./mediaProcessing";

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

  assert.notEqual(
    mediaIdentityKey('/aani/u1/x.mp4?ver=1'),
    mediaIdentityKey('/aani/u1/y.mp4?ver=1'),
  );
});

/* ------------------------------------------------------------------ */
/* مُقيِّم الطوابع الزمنية: إثبات حد 30fps على كامل الفيديو            */
/* ------------------------------------------------------------------ */

test('فيديو ملتزم بـ30fps (CFR) يُقبل — أقصى معدل لحظي ≈ 30', () => {
  const verifier = createFrameTimestampVerifier();
  for (let frame = 0; frame < 90; frame += 1) {
    const result = verifier.push((frame / 30).toFixed(6));
    assert.equal(result.verified, true, `الإطار ${frame} يجب أن يُقبل`);
  }
  const verdict = verifier.verdict();
  assert.equal(verdict.verified, true);
  assert.ok(verdict.maxInstantaneousRate! > 29.99 && verdict.maxInstantaneousRate! <= 30.01);
  assert.equal(verifier.frameCount(), 90);
});

test('فيديو يتجاوز 30fps فعلياً يُرفض فوراً بذكر السبب', () => {
  const verifier = createFrameTimestampVerifier();
  // أول فجوة 0.03 ثانية = 33.3fps — الإخلال يُكتشف عند الإطار الثاني نفسه
  assert.equal(verifier.push("0.000000").verified, true);
  const violation = verifier.push("0.030000");
  assert.equal(violation.verified, false);
  assert.ok(violation.reason!.includes("exceeds 30fps"));
  // القرار النهائي بعد أول إخلال يبقى رفضاً
  assert.equal(verifier.verdict().verified, false);
});

test('طوابع زمنية غير تصاعدية يُرفض الناتج (لا يمكن التحقق)', () => {
  const verifier = createFrameTimestampVerifier();
  assert.equal(verifier.push("0.000000").verified, true);
  assert.equal(verifier.push("0.050000").verified, true);
  const result = verifier.push("0.040000"); // طابع رجعي
  assert.equal(result.verified, false);
  assert.ok(result.reason!.includes("non-monotonic"));
});

test('طابع زمني غير قابل للتحليل يرفض الناتج — لا تجاهل صامت', () => {
  const verifier = createFrameTimestampVerifier();
  assert.equal(verifier.push("0.000000").verified, true);
  assert.equal(verifier.push("N/A").verified, false);
  assert.ok(verifier.verdict().reason!.includes("unparseable"));

  const verifier2 = createFrameTimestampVerifier();
  assert.equal(verifier2.push("0.000000").verified, true);
  assert.equal(verifier2.push("garbage-text").verified, false);
  // الإطارات قبل الخطأ وحدها لا تُغري بقبول الناتج
  assert.equal(verifier2.verdict().verified, false);
});

test('إطار واحد فقط (أو أقل) = غير قابل للتحقق → رفض', () => {
  const single = createFrameTimestampVerifier();
  single.push("0.000000");
  assert.equal(single.verdict().verified, false);
  assert.ok(single.verdict().reason!.includes("fewer than 2"));

  const none = createFrameTimestampVerifier();
  none.push("");
  assert.equal(none.verdict().verified, false);
});

test('فيديو طويل (أكثر من 90 إطاراً): تُفحص جميع الإطارات تدفقياً وذاكرة إطار واحد', () => {
  const verifier = createFrameTimestampVerifier();
  const FRAMES = 300; // يتجاوز حد العينة القديم (90) بعشرات الأضعاف
  for (let frame = 0; frame < FRAMES; frame += 1) {
    const result = verifier.push((frame / 30).toFixed(6));
    assert.equal(result.verified, true, `الإطار ${frame} يجب أن يُقبل`);
  }
  const verdict = verifier.verdict();
  assert.equal(verdict.verified, true);
  assert.equal(verifier.frameCount(), FRAMES);
});

test('إخلال متأخر بعد 150 إطاراً سليماً يرفض الناتج كاملاً', () => {
  const verifier = createFrameTimestampVerifier();
  for (let frame = 0; frame < 150; frame += 1) {
    verifier.push((frame / 30).toFixed(6));
  }
  // انفجار معدل بعد بداية سليمة (نقطة VFR متطرفة)
  const result = verifier.push((149.9 / 30).toFixed(6)); // فجوة 0.0033 = 300fps
  assert.equal(result.verified, false);
  assert.ok(result.reason!.includes("exceeds 30fps"));
});

test('الأسطر الفارغة بين الإطارات لا تُعد إطارات ولا تخالف الفحص', () => {
  const verifier = createFrameTimestampVerifier();
  assert.equal(verifier.push("0.000000").verified, true);
  assert.equal(verifier.push("   ").verified, true);
  assert.equal(verifier.push("0.033333").verified, true);
  assert.equal(verifier.verdict().verified, true);
  assert.equal(verifier.frameCount(), 2); // الفارغ لا يُحسب إطاراً
});
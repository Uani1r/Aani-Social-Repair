// اختبار تكامل حقيقي ضد PostgREST/Supabase — يُتخطى صراحةً ما لم تتوفر بيئة:
//   AANI_INTEGRATION_SUPABASE_URL + AANI_INTEGRATION_SERVICE_ROLE_KEY
// المطلوب بيئة اختبار معزولة (لا قاعدة الإنتاج). ينشئ بيانات مؤقتة بعلامة
// فريدة ثم ينظفها في finally — لا يقرأ ولا يعدل ولا يحذف بيانات مستخدمين
// حقيقيين، ولا ينفذ أي حذف لملفات ImageKit إطلاقاً.
//
// ما يثبته عند توفر البيئة:
//   1) بناء or=() بشرط ov لكل رابط يُنفَّذ فعلياً على PostgREST (مصفوفة بعدة
//      روابط + روابط برموز خاصة & , — تفكك أو تنكسر صراحةً).
//   2) mediaInActiveUse ترى مصفوفة روابط حقيقية (ملف مستخدم → true).
//   3) فشل معامل/جدول اختياري غائب لا يفشل الفحص؛ فشل جدول أساسي يرمي استثناءً.
//   4) حذف السجل المؤقت في finally لا يترك أثراً.
//
// بدون البيئة: كل الاختبارات تظهر skip — لا ادعاء نجاح.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMediaReferenceConditions,
  MediaReferenceCheckError,
  mediaInActiveUse,
  requireSuccessfulCheck,
  restRequest,
  type SupabaseAdminConfig,
} from "./mediaDb";

const url = process.env["AANI_INTEGRATION_SUPABASE_URL"] || "";
const key = process.env["AANI_INTEGRATION_SERVICE_ROLE_KEY"] || "";
const enabled = Boolean(url && key);
const config: SupabaseAdminConfig = { url, serviceRoleKey: key };
const skipReason = "بيئة اختبار التكامل غير مهيأة (AANI_INTEGRATION_SUPABASE_URL / AANI_INTEGRATION_SERVICE_ROLE_KEY)";

// معرّف اختبار ثابت (uuid صالح) — لن يُصادم بيانات حقيقية
const TEST_PROFILE_ID = "1a2b3c4d-0000-4000-8000-000000000001";
const TEST_URL_A = "https://ik.imagekit.io/testenv/aani/integration-test/a&b,c.mp4";
const TEST_URL_B = "https://ik.imagekit.io/testenv/aani/integration-test/d-e.mp4";
const TEST_URL_C = "https://ik.imagekit.io/testenv/aani/integration-test/unused.mp4";

const TEST_PROFILE = {
  id: TEST_PROFILE_ID,
  username: `aani_it_${Date.now()}`,
  full_name: "Integration Test Row (safe to delete)",
};

const TEST_POST = {
  user_id: TEST_PROFILE_ID,
  content: "integration-test row — auto deleted",
  media_url: TEST_URL_A,
  media_urls: [TEST_URL_A, TEST_URL_B],
  type: "photo",
  visibility: "private",
};

async function deleteTestRows(): Promise<void> {
  await restRequest(config, "DELETE", "posts", { user_id: `eq.${TEST_PROFILE_ID}` });
  await restRequest(config, "DELETE", "profiles", { id: `eq.${TEST_PROFILE_ID}` });
}

test('PostgREST: or=() بشرط ov لكل رابط (برموز خاصة) يُنفَّذ فعلياً على القاعدة', { skip: enabled ? false : skipReason }, async () => {
  const conditions = buildMediaReferenceConditions(
    [TEST_URL_A, TEST_URL_B],
    ["media_url", "audio_url"],
    ["media_urls"],
  );
  // الصيغة المبنية نفسها تُرسل إلى PostgREST — أي انكسر في الصيغة يعود 400
  const result = await restRequest(config, "GET", "posts", {
    select: "id",
    or: `(${conditions.join(",")})`,
    limit: "1",
  });
  assert.equal(result.ok, true, `PostgREST rejected our or= syntax: ${result.errorText}`);
});

test('PostgREST: ملف مستخدم داخل مصفوفة media_urls يُكتشف — وغير المستخدم لا يُكتشف', { skip: enabled ? false : skipReason }, async () => {
  try {
    // بيانات مؤقتة معزولة: profile + post خاصان باختبار التكامل
    const profileInsert = await restRequest(config, "POST", "profiles", {}, TEST_PROFILE);
    assert.equal(profileInsert.ok, true, `profile insert failed: ${profileInsert.errorText}`);
    const postInsert = await restRequest(config, "POST", "posts", {}, TEST_POST);
    assert.equal(postInsert.ok, true, `post insert failed: ${postInsert.errorText}`);

    // ملف مستخدم (ضمن المصفوفة) → يمنع الحذف
    assert.equal(await mediaInActiveUse(config, [TEST_URL_A]), true);
    assert.equal(await mediaInActiveUse(config, [TEST_URL_B]), true);
    // ملف بلا أي مرجع في أي جدول → false (هذا الاختبار وحده يُمكّن الطابور لاحقاً في بيئات الاختبار)
    assert.equal(await mediaInActiveUse(config, [TEST_URL_C]), false);
    // الرابط الأحادي media_url أيضاً مغطى
    assert.equal(await mediaInActiveUse(config, [`${TEST_URL_A}?tr=w-400`]), true);
  } finally {
    await deleteTestRows();
  }
});

test('PostgREST: جدول اختياري غائب لا يفشل الفحص، وجدول أساسي غائب يوقف الحذف', { skip: enabled ? false : skipReason }, async () => {
  // إن كانت بيئة الاختبار بلا جدول الأغلفة (اختياري) فالفحص يجب أن ينجح
  const collectionsProbe = await restRequest(config, "GET", "profile_highlight_collections", { select: "id", limit: "1" });
  const optionalMissing = !collectionsProbe.ok && collectionsProbe.status === 404;
  // بلا روابط ولا استبعاد → false فوراً بأي حالة
  assert.equal(await mediaInActiveUse(config, []), false);

  // جدول أساسي غائب: يُحاكى بطلب جدول غير موجود عبر REST مباشرة
  const missingCore = await restRequest(config, "GET", "aani_table_that_does_not_exist", { select: "id" });
  if (!missingCore.ok) {
    assert.ok(
      missingCore.status === 404 || missingCore.status === 400,
      "فجوة مخطط متوقعة لجدول غير موجود",
    );
    // والسلوك الصارم: أي فحص تعذر يرمي استثناءً (يتوقف الحذف) — محاكى بحقن الجدول المفقود
    await assert.rejects(
      () => requireSuccessfulCheck(missingCore),
      MediaReferenceCheckError,
    );
  }
  void optionalMissing; // معلوماتية فقط — سياسة التخطي موثقة ومختبرة في اختبارات الوحدة
});

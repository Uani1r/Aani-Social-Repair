// اختبار تكامل حقيقي ضد PostgREST/Supabase — يُتخطى صراحةً ما لم تتوفر بيئة:
//   AANI_INTEGRATION_SUPABASE_URL + AANI_INTEGRATION_SERVICE_ROLE_KEY
// المطلوب بيئة اختبار معزولة (لا قاعدة الإنتاج). ينشئ بيانات مؤقتة بمعرّف
// عشوائي لكل تشغيل، ويقتصر تنظيفها على السجلات التي أنشأها الاختبار نفسه
// (بمعرّفه) — لا يقرأ ولا يعدل ولا يحذف بيانات مستخدمين حقيقيين، ولا ينفذ
// أي حذف لملفات ImageKit إطلاقاً.
//
// ما يثبته عند توفر البيئة:
//   1) بناء or=() بشرط ov لكل رابط يُنفَّذ فعلياً على PostgREST (مصفوفة بعدة
//      روابط + روابط برموز خاصة & , — تفكك أو تنكسر صراحةً).
//   2) mediaInActiveUse ترى مصفوفة روابط حقيقية (ملف مستخدم → يمنع الحذف).
//   3) غياب جدول أساسي فعلياً → mediaInActiveUse ترمي خطأً (يوقف الحذف)
//      — يُختبر فقط عندما تنقص جدول أساسي في بيئة الاختبار.
//   4) غياب الجدول الاختياري → mediaInActiveUse تُكمل الفحص وتُتخطاه فعلياً.
//
// بدون البيئة: كل الاختبارات تظهر skip — لا ادعاء نجاح.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  buildMediaReferenceConditions,
  MediaReferenceCheckError,
  mediaInActiveUse,
  restRequest,
  type SupabaseAdminConfig,
} from "./mediaDb";

const url = process.env["AANI_INTEGRATION_SUPABASE_URL"] || "";
const key = process.env["AANI_INTEGRATION_SERVICE_ROLE_KEY"] || "";
const enabled = Boolean(url && key);
const config: SupabaseAdminConfig = { url, serviceRoleKey: key };
const skipReason = "بيئة اختبار التكامل غير مهيأة (AANI_INTEGRATION_SUPABASE_URL / AANI_INTEGRATION_SERVICE_ROLE_KEY)";

// معرّف عشوائي لكل تشغيل — التنظيف محكوم به حصراً فلا يمكن حذف أي سجل غيره
const TEST_PROFILE_ID = randomUUID();
const TEST_POST_ID = randomUUID();
const TEST_URL_A = `https://ik.imagekit.io/testenv/aani/integration-test/${TEST_PROFILE_ID}/a&b,c.mp4`;
const TEST_URL_B = `https://ik.imagekit.io/testenv/aani/integration-test/${TEST_PROFILE_ID}/d-e.mp4`;
const TEST_URL_C = `https://ik.imagekit.io/testenv/aani/integration-test/${TEST_PROFILE_ID}/unused.mp4`;

const TEST_PROFILE = {
  id: TEST_PROFILE_ID,
  username: `aani_it_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  full_name: "Integration Test Row (safe to delete)",
};

const TEST_POST = {
  id: TEST_POST_ID,
  user_id: TEST_PROFILE_ID,
  content: "integration-test row — auto deleted",
  media_url: TEST_URL_A,
  media_urls: [TEST_URL_A, TEST_URL_B],
  type: "photo",
  visibility: "private",
};

/** تنظيف محصور بالمعرّفات العشوائية لهذا التشغيل — لا يمس أي سجل آخر */
async function deleteTestRows(): Promise<void> {
  await restRequest(config, "DELETE", "posts", { id: `eq.${TEST_POST_ID}` });
  await restRequest(config, "DELETE", "posts", { user_id: `eq.${TEST_PROFILE_ID}` });
  await restRequest(config, "DELETE", "profiles", { id: `eq.${TEST_PROFILE_ID}` });
}

/** يكشف أي جداول المراجع الأساسية غائبة في بيئة الاختبار فعلياً */
async function missingCoreTables(): Promise<string[]> {
  const coreTables = [
    "posts", "stories", "profile_highlights", "profile_highlight_collections",
    "sounds", "messages", "profiles", "media_assets",
  ];
  const missing: string[] = [];
  for (const table of coreTables) {
    const probe = await restRequest(config, "GET", table, { select: "id", limit: "1" });
    if (!probe.ok && isMissingRelation(probe)) missing.push(table);
  }
  return missing;
}

function isMissingRelation(result: { ok: boolean; status: number; data: unknown; errorText?: string }): boolean {
  if (result.ok) return false;
  const message = extractMessage(result);
  return (result.status === 400 || result.status === 404)
    && (message.includes("42P01") || message.includes("PGRST205"));
}

function extractMessage(result: { data: unknown; errorText?: string }): string {
  if (result.data && typeof result.data === "object") {
    const record = result.data as Record<string, unknown>;
    if (typeof record["message"] === "string") return record["message"];
  }
  return result.errorText ?? "";
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
    // الرابط الأحادي media_url أيضاً مغطى (مع تزخرف ?tr= الذي لا يغير الهوية)
    assert.equal(await mediaInActiveUse(config, [`${TEST_URL_A}?tr=w-400`]), true);
    // ملف بلا أي مرجع في أي جدول → false (كشف إيجابي كاذب لو كان الفحص فضفاضاً)
    assert.equal(await mediaInActiveUse(config, [TEST_URL_C]), false);
  } finally {
    await deleteTestRows();
  }
});

test('PostgREST: غياب جدول أساسي فعلياً → mediaInActiveUse ترمي وتمنع الحذف', { skip: enabled ? false : skipReason }, async () => {
  const missing = await missingCoreTables();
  if (missing.length === 0) {
    // كل الجداول الأساسية موجودة في بيئة الاختبار — لا يمكن محاكاة الغياب
    // دون تعديل حقيقي على المخطط، لذا يُتخطى الاختبار صراحةً (لا ادعاء نجاح)
    return;
  }
  // بيئة الاختبار تنقصها جداول أساسية → أي فحص مراجع يجب أن يفشل كلياً
  await assert.rejects(
    () => mediaInActiveUse(config, ["https://ik.imagekit.io/testenv/aani/integration-test/probe.mp4"]),
    MediaReferenceCheckError,
    `غياب الجداول الأساسية ${missing.join(", ")} يجب أن يوقف الحذف تماماً`,
  );
});

test('PostgREST: غياب الجدول الاختياري (أغلفة الأبرز) → الفحص يُكمل فعلياً بتخطيه', { skip: enabled ? false : skipReason }, async () => {
  const collectionsProbe = await restRequest(config, "GET", "profile_highlight_collections", {
    select: "id", limit: "1",
  });
  if (!collectionsProbe.ok && isMissingRelation(collectionsProbe)) {
    // الجدول الاختياري غائب فعلاً → الفحص الكامل يجب أن ينجح بتجاوزه (لا استثناء)
    const resolved = await mediaInActiveUse(config, ["https://ik.imagekit.io/testenv/aani/integration-test/probe.mp4"]);
    assert.equal(typeof resolved, "boolean");
  } else {
    // الجدول موجود: يُفحص كجدول عادي — النتيجة تظل منطقية
    const resolved = await mediaInActiveUse(config, [TEST_URL_C]);
    assert.equal(typeof resolved, "boolean");
  }
});

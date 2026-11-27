// اختبارات Deno لقرار معرّف مشروع FCM: حساب الخدمة هو المصدر الوحيد.
//
// تُشغَّل بـ: deno test --allow-read tests/fcm-project.test.ts
// بلا شبكة ولا مفاتيح ولا مشروع Firebase: القرار نقي في _shared/fcmProject.ts.

import {
  FIREBASE_PROJECT_ERRORS,
  FORBIDDEN_FIREBASE_PROJECT,
  FirebaseProjectError,
  resolveFirebaseProjectId,
} from "../_shared/fcmProject.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function capture(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the call to fail, but it returned");
}

const ACCOUNT_PROJECT = "ani-social-app";
const OTHER_PROJECT = "another-project";

Deno.test("لا معرّف مشروع بلا حساب خدمة، والمتغير لا يخترع واحداً", () => {
  const missing = capture(() => resolveFirebaseProjectId(undefined, undefined));
  assertEqual(missing.message, FIREBASE_PROJECT_ERRORS.missing, "a missing project_id must stop the worker");
  assert(missing instanceof FirebaseProjectError && missing.code === "missing", "the error carries the code only");

  // متغير مضبوط بلا project_id في الحساب: لا يُستخدم ولا يُخمَّن معرّف.
  const envOnly = capture(() => resolveFirebaseProjectId("", OTHER_PROJECT));
  assertEqual(envOnly.message, FIREBASE_PROJECT_ERRORS.missing, "the env var never replaces a missing project_id");

  const blank = capture(() => resolveFirebaseProjectId("   ", undefined));
  assertEqual(blank.message, FIREBASE_PROJECT_ERRORS.missing, "a blank project_id is missing");
});

Deno.test("غياب FIREBASE_PROJECT_ID يعتمد على حساب الخدمة", () => {
  assertEqual(resolveFirebaseProjectId(ACCOUNT_PROJECT, undefined), ACCOUNT_PROJECT, "no env var uses the account");
  assertEqual(resolveFirebaseProjectId(ACCOUNT_PROJECT, ""), ACCOUNT_PROJECT, "an empty env var uses the account");
  assertEqual(resolveFirebaseProjectId(ACCOUNT_PROJECT, "   "), ACCOUNT_PROJECT, "a blank env var uses the account");
  assertEqual(
    resolveFirebaseProjectId(`  ${ACCOUNT_PROJECT}  `, undefined),
    ACCOUNT_PROJECT,
    "the account project id is trimmed",
  );
});

Deno.test("تطابق القيمتين يُقبل", () => {
  assertEqual(resolveFirebaseProjectId(ACCOUNT_PROJECT, ACCOUNT_PROJECT), ACCOUNT_PROJECT, "equal values pass");
  assertEqual(
    resolveFirebaseProjectId(ACCOUNT_PROJECT, ` ${ACCOUNT_PROJECT} `),
    ACCOUNT_PROJECT,
    "equal values after trimming pass",
  );
});

Deno.test("اختلاف Project ID يوقف التنفيذ بلا كشف أي قيمة", () => {
  const error = capture(() => resolveFirebaseProjectId(ACCOUNT_PROJECT, OTHER_PROJECT));
  assertEqual(error.message, FIREBASE_PROJECT_ERRORS.mismatch, "a mismatch must stop the worker");
  assert(error instanceof FirebaseProjectError && error.code === "mismatch", "the mismatch has its own code");
  assert(!error.message.includes(ACCOUNT_PROJECT), "the account project id is not echoed");
  assert(!error.message.includes(OTHER_PROJECT), "the env project id is not echoed");
  assert(!/private_key|client_email|secret/i.test(error.message), "no secret field name leaks in the error");
});

Deno.test("مشروع Firebase القديم مرفوض في الحساب وفي المتغير", () => {
  const fromAccount = capture(() => resolveFirebaseProjectId(FORBIDDEN_FIREBASE_PROJECT, undefined));
  assertEqual(fromAccount.message, FIREBASE_PROJECT_ERRORS.forbidden, "the legacy project in the account is refused");

  const fromEnv = capture(() => resolveFirebaseProjectId(ACCOUNT_PROJECT, FORBIDDEN_FIREBASE_PROJECT));
  assertEqual(fromEnv.message, FIREBASE_PROJECT_ERRORS.forbidden, "the legacy project in the env var is refused");

  // حتى حين تتطابق القيمتان على المشروع القديم نفسه.
  const both = capture(() => resolveFirebaseProjectId(FORBIDDEN_FIREBASE_PROJECT, FORBIDDEN_FIREBASE_PROJECT));
  assertEqual(both.message, FIREBASE_PROJECT_ERRORS.forbidden, "the legacy project is refused even when equal");
  assert(!fromAccount.message.includes(FORBIDDEN_FIREBASE_PROJECT), "the legacy id itself is not echoed");
});

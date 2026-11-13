// اختبارات خوارزمية توقيع الرفع المباشر لـ ImageKit.
//
// المرجع الرسمي: حزمة imagekit-nodejs الرسمية
// (src/resources/helper.ts → getAuthenticationParameters):
//
//   signature = HMAC-SHA1(key = privateKey, message = token + expire)
//
// هذه الاختبارات تثبت أن buildImageKitSignature يطبق الصيغة نفسها بالضبط،
// وتضمن أن التوقيع لا يعود إلى SHA1 العادي لدمج privateKey+token+expire.

import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";

import { buildImageKitSignature, describeExpireValue } from "./mediaDiagnostics";

function referenceHmac(privateKey: string, token: string, expire: number): string {
  return crypto.createHmac("sha1", privateKey).update(`${token}${expire}`, "utf8").digest("hex");
}

test("buildImageKitSignature: يطابق HMAC-SHA1(privateKey, token+expire) كما في حزمة ImageKit الرسمية", () => {
  const privateKey = "private_test-key-42:";
  const token = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
  const expire = 1770561600;

  assert.equal(buildImageKitSignature(privateKey, token, expire), referenceHmac(privateKey, token, expire));
});

test("buildImageKitSignature: الناتج hex بطول 40", () => {
  const signature = buildImageKitSignature("private_k", "token-abc", 1770561600);
  assert.equal(signature.length, 40);
  assert.match(signature, /^[0-9a-f]{40}$/);
});

test("buildImageKitSignature: يختلف عن SHA1 العادي لدمج privateKey+token+expire (الخوارزمية القديمة الخاطئة)", () => {
  const privateKey = "private_k";
  const token = "token-abc";
  const expire = 1770561600;

  const legacySha1 = crypto.createHash("sha1").update(`${privateKey}${token}${expire}`).digest("hex");
  assert.notEqual(buildImageKitSignature(privateKey, token, expire), legacySha1);
});

test("buildImageKitSignature: الناتج دالة حقيقية في الرسالة كاملة (token+expire) لا في جزء منها", () => {
  // HMAC-SHA1 معروف بقيمه المرجعية: key='key' والرسالة
  // 'The quick brown fox jumps over the lazy dog' تنتج
  // de7c9b85b8b78aa6bc8a7a33f4cce80e560a452c42 — الدالة تُلحق
  // expire بالنص، لذلك نكرر المعادلة على الرسالة الكاملة كما تصيغها الدالة.
  const message = "The quick brown fox jumps over the lazy dog";
  const signature = buildImageKitSignature("key", message, 0);
  const direct = crypto.createHmac("sha1", "key").update(`${message}0`, "utf8").digest("hex");
  assert.equal(signature, direct);
  assert.equal(signature.length, 40);
  // وتغيير expire واحد بت واحد يغيّر التوقيع كلياً
  assert.notEqual(signature, buildImageKitSignature("key", message, 1));
});

test("describeExpireValue: صيغة ثوانٍ unix ضمن الحد", () => {
  const expire = Math.floor(Date.now() / 1000) + 1800;
  assert.match(describeExpireValue(expire), /ثوانٍ unix صحيحة/);
});

test("describeExpireValue: قيمة منتهية تُرفض بوضوح", () => {
  const expire = Math.floor(Date.now() / 1000) - 10;
  assert.match(describeExpireValue(expire), /منتهٍ/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseVoiceMessageUrl } from './voiceMessageContent';

const PREFIX = '[aani-audio:v1]';
const IMAGEKIT_URL = 'https://ik.imagekit.io/anisocial/aani/00000000-0000-0000-0000-000000000001/messages/11111111-1111-4111-8111-111111111111.m4a';

function content(url: unknown): string {
  return `${PREFIX}${JSON.stringify({ url, durationMs: 1200 })}`;
}

test('the server extracts an ImageKit voice URL with the account endpoint prefix', () => {
  assert.equal(parseVoiceMessageUrl(content(IMAGEKIT_URL)), IMAGEKIT_URL);
  // شكل بلا معرّف endpoint
  assert.equal(
    parseVoiceMessageUrl(content(IMAGEKIT_URL.replace('/anisocial', ''))),
    IMAGEKIT_URL.replace('/anisocial', ''),
  );
});

test('the server strips query and fragment from the stored URL', () => {
  assert.equal(
    parseVoiceMessageUrl(content(`${IMAGEKIT_URL}?tr=q-auto#t=1`)),
    IMAGEKIT_URL,
  );
});

test('anything that is not an ImageKit voice file is not deletable', () => {
  // رابط Supabase قديم: لا هدف حذف في ImageKit
  assert.equal(
    parseVoiceMessageUrl(content('https://example.supabase.co/storage/v1/object/public/aani-media/u/messages/x.webm')),
    null,
  );
  // نطاق خارجي
  assert.equal(parseVoiceMessageUrl(content(IMAGEKIT_URL.replace('ik.imagekit.io', 'evil.example'))), null);
  // خارج /aani
  assert.equal(parseVoiceMessageUrl(content(IMAGEKIT_URL.replace('/aani/', '/other/'))), null);
  // http
  assert.equal(parseVoiceMessageUrl(content(IMAGEKIT_URL.replace('https://', 'http://'))), null);
  // محتوى ليس رسالة صوتية أو بيانات مشوهة
  assert.equal(parseVoiceMessageUrl('مرحباً'), null);
  assert.equal(parseVoiceMessageUrl(`${PREFIX}{`), null);
  assert.equal(parseVoiceMessageUrl(`${PREFIX}null`), null);
  assert.equal(parseVoiceMessageUrl(content(123)), null);
  assert.equal(parseVoiceMessageUrl(content('')), null);
});

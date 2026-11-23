import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const srcRoot = new URL('..', import.meta.url);
const read = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, srcRoot)), 'utf8');

test('message media deletion is scheduled inside the database, after the delete', () => {
  const migration = read('../supabase/migrations/20270124000000_media_outbox_hardening.sql');

  // المسار الوحيد: Trigger بعد حذف الصف يجمع كل رابط في المحتوى ويجدوله
  assert.equal(migration.includes('create or replace function public.aani_queue_deleted_message_media()'), true);
  assert.equal(/create trigger aani_queue_deleted_message_media\s+after delete on public\.messages/i.test(migration), true);
  assert.equal(migration.includes('for each row execute function public.aani_queue_deleted_message_media()'), true);
  assert.equal(migration.includes('perform public.aani_enqueue_media_deletion_job(media_url);'), true);
  // الرابط يُخزَّن بلا معاملات استعلام
  assert.equal(migration.includes("regexp_replace(p_media_url, '[?#].*$', '')"), true);
});

test('the client does not schedule deletion after the RPC removed the row', () => {
  const page = read('./pages/MessagesPage.tsx');

  // لا نداء حذف من العميل بعد aani_delete_message_for_everyone: الصف لم يعد موجوداً
  assert.equal(page.includes('imagekit-delete'), false);
  assert.equal(page.includes('enqueueVoiceMessageMediaDeletion'), false);
  // الحذف «لدى الجميع» لا يزال عبر RPC القائم
  assert.equal(page.includes('aani_delete_message_for_everyone'), true);
});

test('the server keeps a single deletion path (no message kind in mediaCleanup)', () => {
  const cleanup = read('../../api-server/src/routes/mediaCleanup.ts');

  assert.equal(cleanup.includes('"message"'), false);
  assert.equal(cleanup.includes('kind === "message"'), false);
  // القصص والمنشورات كما هي
  assert.equal(cleanup.includes('kind === "post"'), true);
});

test('the deletion worker re-checks live references before removing a file', () => {
  const worker = read('../../api-server/src/lib/mediaDeletionWorker.ts');

  const referenceCheck = worker.indexOf('mediaInActiveUse(config, [mediaUrl])');
  const deleteCall = worker.indexOf('deleteImageKitFilesByUrls([mediaUrl])');
  assert.ok(referenceCheck >= 0, 'the reference check must exist');
  assert.ok(deleteCall >= 0, 'the ImageKit delete must exist');
  assert.ok(referenceCheck < deleteCall, 'references are checked before any delete');
  // لا نجاح وهمي: يميّز deleted من verifiedAbsent
  assert.equal(worker.includes('result.verifiedAbsent > 0'), true);
});

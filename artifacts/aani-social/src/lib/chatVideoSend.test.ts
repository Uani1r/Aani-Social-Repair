import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_VIDEO_MESSAGE_PREFIX, parseChatVideoMessage } from './chatVideo';
import { sendChatMediaSelection, type ChatMediaSendDeps, type ChatMediaSelectionItem } from './chatVideoSend';

const IMAGE_PREFIX = '[aani-image:v1]';

function videoFile(name = 'studio.mp4'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'video/mp4' });
}

function imageFile(name = 'photo.jpg'): File {
  return new File([new Uint8Array([4, 5, 6])], name, { type: 'image/jpeg' });
}

type Calls = {
  prepared: File[];
  uploadedVideos: File[];
  uploadedImages: File[];
  uploadedPosters: File[];
  inserted: Array<{ content: string; kind: 'image' | 'video' }>;
};

function createDeps(overrides: Partial<ChatMediaSendDeps> = {}) {
  const calls: Calls = { prepared: [], uploadedVideos: [], uploadedImages: [], uploadedPosters: [], inserted: [] };
  const deps: ChatMediaSendDeps = {
    imageMessagePrefix: IMAGE_PREFIX,
    caption: 'تعليق',
    viewOnce: false,
    async prepareVideo(file) {
      calls.prepared.push(file);
      return {
        ok: true,
        file: videoFile('compressed-720p.mp4'),
        poster: imageFile('poster.jpg'),
        durationMs: 12_000,
        metrics: { width: 1280, height: 720 },
      };
    },
    async uploadImage(item) {
      calls.uploadedImages.push(item.file);
      return `https://ik.imagekit.io/anisocial/aani/u1/messages/${item.id}.jpg`;
    },
    async uploadVideo(_item, prepared) {
      calls.uploadedVideos.push(prepared.file as File);
      return 'https://ik.imagekit.io/anisocial/aani/u1/messages/video.mp4';
    },
    async uploadPoster(_item, poster) {
      calls.uploadedPosters.push(poster);
      return 'https://ik.imagekit.io/anisocial/aani/u1/messages/poster.jpg';
    },
    async insertMessage(content, kind) {
      calls.inserted.push({ content, kind });
    },
    ...overrides,
  };
  return { deps, calls };
}

test('a studio video is compressed first, and the compressed file is what gets uploaded', async () => {
  const { deps, calls } = createDeps();
  const original = videoFile();
  const items: ChatMediaSelectionItem[] = [{ id: 'v1', type: 'video', file: original }];

  const result = await sendChatMediaSelection(items, deps);

  assert.equal(result.ok, true);
  assert.equal(calls.prepared.length, 1);
  assert.equal(calls.prepared[0], original);
  assert.equal(calls.uploadedVideos.length, 1);
  assert.notEqual(calls.uploadedVideos[0], original);
  assert.equal(calls.uploadedVideos[0]?.name, 'compressed-720p.mp4');
  assert.equal(calls.inserted.length, 1);
  const payload = parseChatVideoMessage(calls.inserted[0]!.content);
  assert.ok(payload, 'video message must parse as a chat video');
  assert.equal(payload!.url, 'https://ik.imagekit.io/anisocial/aani/u1/messages/video.mp4');
  assert.equal(payload!.posterUrl, 'https://ik.imagekit.io/anisocial/aani/u1/messages/poster.jpg');
  assert.equal(payload!.durationMs, 12_000);
  assert.equal(payload!.width, 1280);
  assert.equal(payload!.caption, 'تعليق');
  assert.equal(calls.inserted[0]!.content.startsWith(CHAT_VIDEO_MESSAGE_PREFIX), true);
});

test('no upload happens when the video preparation fails, and no video message is created', async () => {
  const { deps, calls } = createDeps({
    async prepareVideo() {
      return { ok: false, message: 'تعذر ضغط المقطع' };
    },
  });

  const result = await sendChatMediaSelection([{ id: 'v1', type: 'video', file: videoFile() }], deps);

  assert.equal(result.ok, false);
  assert.equal(calls.uploadedVideos.length, 0);
  assert.equal(calls.uploadedPosters.length, 0);
  assert.equal(calls.inserted.length, 0);
  assert.equal(result.failedVideos.length, 1);
});

test('a video that loses its audio is rejected before any upload', async () => {
  const { deps, calls } = createDeps({
    async prepareVideo() {
      return { ok: false, reason: 'audio-lost', message: 'فقد المسار الصوتي' };
    },
  });

  const result = await sendChatMediaSelection([{ id: 'v1', type: 'video', file: videoFile() }], deps);

  assert.equal(result.ok, false);
  assert.equal(calls.uploadedVideos.length, 0);
  assert.equal(result.failedVideos[0]?.message, 'فقد المسار الصوتي');
});

test('a failed video preparation does not block normal images', async () => {
  const { deps, calls } = createDeps({
    async prepareVideo() {
      return { ok: false, message: 'تعذر ضغط المقطع' };
    },
  });

  const result = await sendChatMediaSelection(
    [
      { id: 'i1', type: 'image', file: imageFile('a.jpg') },
      { id: 'v1', type: 'video', file: videoFile() },
    ],
    deps,
  );

  assert.equal(calls.uploadedImages.length, 1);
  assert.equal(calls.inserted.length, 1);
  assert.equal(calls.inserted[0]!.kind, 'image');
  assert.equal(calls.inserted[0]!.content.startsWith(IMAGE_PREFIX), true);
  assert.equal(calls.uploadedVideos.length, 0);
  assert.equal(result.failedVideos.length, 1);
});

test('images keep their own message and stay out of the video payload', async () => {
  const { deps, calls } = createDeps();

  const result = await sendChatMediaSelection(
    [
      { id: 'i1', type: 'image', file: imageFile('a.jpg') },
      { id: 'v1', type: 'video', file: videoFile() },
    ],
    deps,
  );

  assert.equal(result.ok, true);
  assert.equal(result.messageCount, 2);
  const kinds = calls.inserted.map(entry => entry.kind);
  assert.deepEqual(kinds, ['image', 'video']);
  const imagePayload = JSON.parse(calls.inserted[0]!.content.slice(IMAGE_PREFIX.length)) as { urls: string[] };
  assert.equal(imagePayload.urls.length, 1);
  assert.equal(imagePayload.urls[0]?.includes('/messages/i1.jpg'), true);
});

test('a mixed selection sends every item exactly once, in order, with its own caption', async () => {
  const { deps, calls } = createDeps();
  const items: ChatMediaSelectionItem[] = [
    { id: 'i1', type: 'image', file: imageFile('a.jpg') },
    { id: 'v1', type: 'video', file: videoFile('one.mp4') },
    { id: 'i2', type: 'image', file: imageFile('b.jpg') },
    { id: 'v2', type: 'video', file: videoFile('two.mp4') },
  ];

  const result = await sendChatMediaSelection(items, { ...deps, viewOnce: true });

  assert.equal(result.ok, true);
  assert.equal(calls.uploadedImages.length, 2);
  assert.equal(calls.uploadedVideos.length, 2);
  assert.equal(result.messageCount, 3); // رسالة صور واحدة + رسالتا فيديو
  const imageContent = calls.inserted[0]!.content;
  const imagePayload = JSON.parse(imageContent.slice(IMAGE_PREFIX.length)) as { viewOnce: boolean; urls: string[] };
  assert.equal(imagePayload.viewOnce, true);
  assert.equal(imagePayload.urls.length, 2);
  for (const entry of calls.inserted.slice(1)) {
    const payload = parseChatVideoMessage(entry.content);
    assert.ok(payload);
    assert.equal(payload!.viewOnce, true);
    assert.equal(payload!.caption, 'تعليق');
  }
});

test('an upload failure stops the batch and is reported instead of sending a partial video message', async () => {
  const { deps, calls } = createDeps({
    async uploadVideo() {
      throw new Error('ImageKit HTTP 403');
    },
  });

  const result = await sendChatMediaSelection([{ id: 'v1', type: 'video', file: videoFile() }], deps);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.stage, 'upload');
  assert.equal(calls.inserted.length, 0);
});

test('an insert failure after a successful upload is reported, not swallowed', async () => {
  const { deps } = createDeps({
    async insertMessage() {
      throw new Error('messages insert rejected');
    },
  });

  const result = await sendChatMediaSelection([{ id: 'v1', type: 'video', file: videoFile() }], deps);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.stage, 'insert');
});

test('a video without a poster still sends a valid payload with a null poster', async () => {
  const { deps, calls } = createDeps({
    async prepareVideo() {
      return { ok: true, file: videoFile('c.mp4'), poster: null, durationMs: 5_000, metrics: { width: 640, height: 360 } };
    },
  });

  await sendChatMediaSelection([{ id: 'v1', type: 'video', file: videoFile() }], deps);

  assert.equal(calls.uploadedPosters.length, 0);
  const payload = parseChatVideoMessage(calls.inserted[0]!.content);
  assert.equal(payload!.posterUrl, null);
  assert.equal(payload!.durationMs, 5_000);
  assert.equal(payload!.width, 640);
});

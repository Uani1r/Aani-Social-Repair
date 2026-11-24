// إرسال دفعة وسائط المحادثة: فيديو الاستوديو يُضغط ويُتحقق قبل الرفع، والصور على مسارها.
//
// الوحدة صرفة (تبعيات محقونة) لتُختبر سلوكياً في Node:
//   prepareVideo → (رفع الصور) → (رفع الفيديو) → رفع الغلاف → إدراج رسالة الفيديو
//   → إدراج رسالة الصور.
//
// - لا يُرفع أي فيديو قبل نجاح prepareVideo.
// - الملف المرفوع هو الملف المضغوط الناتج حصراً.
// - فشل فيديو لا يمنع إرسال الصور، ولا يُنشئ رسالة فيديو.
// - لا تُخلط روابط الصور والفيديو في حمولة واحدة.

import { chatVideoMessageContent } from '@/lib/chatVideo';

export interface ChatMediaSelectionItem {
  id: string;
  type: 'image' | 'video';
  file: File;
}

/** نتيجة prepareChatVideo كما تستخدمها الوحدة (بلا استيراد وحدات المتصفح). */
export interface ChatVideoPreparationLike {
  ok: boolean;
  file?: File | null;
  poster?: File | null;
  durationMs?: number;
  metrics?: { width?: number; height?: number } | null;
  message?: string;
  reason?: string;
}

export interface ChatMediaSendDeps {
  /** بادئة رسالة الصور الحالية (تحقن من المكوّن لتفادي استيراد واجهة). */
  imageMessagePrefix: string;
  caption: string;
  viewOnce: boolean;
  prepareVideo(file: File): Promise<ChatVideoPreparationLike>;
  uploadImage(item: ChatMediaSelectionItem, index: number): Promise<string>;
  uploadVideo(item: ChatMediaSelectionItem, prepared: ChatVideoPreparationLike): Promise<string>;
  uploadPoster(item: ChatMediaSelectionItem, poster: File): Promise<string | null>;
  insertMessage(content: string, kind: 'image' | 'video'): Promise<void>;
}

export interface ChatVideoSendFailure {
  itemId: string;
  message: string;
}

export type ChatMediaSendResult =
  | {
      ok: true;
      imageUrls: string[];
      videoUrls: string[];
      messageCount: number;
      failedVideos: ChatVideoSendFailure[];
    }
  | {
      ok: false;
      stage: 'video-prepare' | 'upload' | 'insert';
      message: string;
      imageUrls: string[];
      videoUrls: string[];
      failedVideos: ChatVideoSendFailure[];
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function sendChatMediaSelection(
  items: readonly ChatMediaSelectionItem[],
  deps: ChatMediaSendDeps,
): Promise<ChatMediaSendResult> {
  const images = items.filter(item => item.type === 'image');
  const videos = items.filter(item => item.type === 'video');

  // 1) تحضير كل فيديو قبل أي رفع: فشل التحضير يمنع رفع ذلك الفيديو فقط.
  const preparedVideos: Array<{ item: ChatMediaSelectionItem; prepared: ChatVideoPreparationLike }> = [];
  const failedVideos: ChatVideoSendFailure[] = [];
  for (const item of videos) {
    let prepared: ChatVideoPreparationLike;
    try {
      prepared = await deps.prepareVideo(item.file);
    } catch (error) {
      prepared = { ok: false, message: errorMessage(error) };
    }
    if (!prepared.ok || !prepared.file) {
      failedVideos.push({
        itemId: item.id,
        message: prepared.message || 'تعذر تجهيز الفيديو — لم يُرفع أي ملف.',
      });
      continue;
    }
    preparedVideos.push({ item, prepared });
  }

  const imageUrls: string[] = [];
  const videoUrls: string[] = [];

  // 2) الصور على مسارها القديم تماماً (بلا تغيير في الضغط أو الحمولة).
  try {
    for (let index = 0; index < images.length; index += 1) {
      imageUrls.push(await deps.uploadImage(images[index]!, index));
    }
  } catch (error) {
    return { ok: false, stage: 'upload', message: errorMessage(error), imageUrls, videoUrls, failedVideos };
  }

  if (images.length) {
    try {
      await deps.insertMessage(
        `${deps.imageMessagePrefix}${JSON.stringify({
          urls: imageUrls,
          caption: deps.caption,
          viewOnce: deps.viewOnce,
        })}`,
        'image',
      );
    } catch (error) {
      return { ok: false, stage: 'insert', message: errorMessage(error), imageUrls, videoUrls, failedVideos };
    }
  }

  // 3) كل فيديو: رفع الملف المضغوط فقط، ثم غلافه، ثم رسالة فيديو مستقلة.
  for (const { item, prepared } of preparedVideos) {
    let videoUrl: string;
    try {
      videoUrl = await deps.uploadVideo(item, prepared);
    } catch (error) {
      return { ok: false, stage: 'upload', message: errorMessage(error), imageUrls, videoUrls, failedVideos };
    }
    videoUrls.push(videoUrl);

    let posterUrl: string | null = null;
    if (prepared.poster) {
      try {
        posterUrl = await deps.uploadPoster(item, prepared.poster);
      } catch (error) {
        // صورة الغلاف اختيارية: فشلها لا يُسقط الفيديو ولا يُنشئ رسالة صوتية وهمية.
        console.warn('[messages] تعذر رفع صورة غلاف الفيديو:', error);
        posterUrl = null;
      }
    }

    try {
      await deps.insertMessage(
        chatVideoMessageContent({
          url: videoUrl,
          durationMs: prepared.durationMs ?? 0,
          posterUrl,
          caption: deps.caption,
          viewOnce: deps.viewOnce,
          width: prepared.metrics?.width ?? 0,
          height: prepared.metrics?.height ?? 0,
        }),
        'video',
      );
    } catch (error) {
      return { ok: false, stage: 'insert', message: errorMessage(error), imageUrls, videoUrls, failedVideos };
    }
  }

  if (failedVideos.length === 0) {
    return {
      ok: true,
      imageUrls,
      videoUrls,
      messageCount: (imageUrls.length ? 1 : 0) + videoUrls.length,
      failedVideos,
    };
  }
  return {
    ok: false,
    stage: 'video-prepare',
    message: failedVideos[0]?.message ?? 'تعذر تجهيز الفيديو — لم يُرفع أي ملف.',
    imageUrls,
    videoUrls,
    failedVideos,
  };
}

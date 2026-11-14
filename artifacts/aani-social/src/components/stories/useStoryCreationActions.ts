import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { toast } from 'sonner';

import type { StoryDrawStroke } from '@/lib/appShared';
import type { StoryCanvasStyle, StoryMediaTransformOverlay, StoryTextOverlay, StoryTimedText } from '@/components/stories/types';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { stopInstant } from '@/lib/instantAudio';
import { uploadStoryMedia } from '@/lib/storyUpload';
import { createVideoPoster } from '@/lib/videoPoster';
import { reportMediaStageFailure } from '@/lib/mediaDiagnostics';
import type { Profile } from '@/lib/types';
import type { StorySound } from '@/lib/sounds';
import { encodeStoryFilterKey, type StoryAdjustments } from '@/lib/storyFilters';
import { STORY_MENTION_CONTENT_MARKER } from '@/lib/storyReplyMessages';
import type { StoryRow as StoryDmCardStory } from '../StoryDmCard';
import type { MentionCandidate } from '../StoryMentionPicker';

type TimedText = StoryTimedText;

function liveReshareStoryId(story: StoryDmCardStory | null): string | null {
  const expiresAt = story?.expires_at ? Date.parse(story.expires_at) : Number.NaN;
  return story?.media_url && Number.isFinite(expiresAt) && expiresAt > Date.now() ? story.id : null;
}

interface UseStoryCreationActionsOptions {
  userId: string;
  currentProfile: Profile | null;
  storyFile: File | null;
  reshareStory: StoryDmCardStory | null;
  caption: string;
  isCloseFriendsOnly: boolean;
  uploadDuration: number;
  storyMediaOffset: { x: number; y: number };
  storyMediaZoom: number;
  storyMediaRotate: number;
  timedTexts: TimedText[];
  storyDrawStrokes: StoryDrawStroke[];
  storyFilterId: string;
  storyFilterAdjustments: StoryAdjustments;
  storyMentions: MentionCandidate[];
  fetchStories: () => Promise<void>;
  setUploading: Dispatch<SetStateAction<boolean>>;
  setUploadProgress: Dispatch<SetStateAction<number>>;
  setStoryFile: Dispatch<SetStateAction<File | null>>;
  setReshareStory: Dispatch<SetStateAction<StoryDmCardStory | null>>;
  setReshareScaledDown: Dispatch<SetStateAction<boolean>>;
  setCaption: Dispatch<SetStateAction<string>>;
  setTimedTexts: Dispatch<SetStateAction<TimedText[]>>;
  setStoryDrawStrokes: Dispatch<SetStateAction<StoryDrawStroke[]>>;
  setStoryDrawingOpen: Dispatch<SetStateAction<boolean>>;
  activeStoryDrawStrokeRef: MutableRefObject<StoryDrawStroke | null>;
  setStoryMentions: Dispatch<SetStateAction<MentionCandidate[]>>;
  setStoryDurationOpen: Dispatch<SetStateAction<boolean>>;
  storyDurationManuallyChosenRef: MutableRefObject<boolean>;
  setShowUploadModal: Dispatch<SetStateAction<boolean>>;
  setStoryText: Dispatch<SetStateAction<string>>;
  storySound: StorySound | null;
  setStorySound: Dispatch<SetStateAction<StorySound | null>>;
}

export function useStoryCreationActions({
  userId,
  currentProfile,
  storyFile,
  reshareStory,
  caption,
  isCloseFriendsOnly,
  uploadDuration,
  storyMediaOffset,
  storyMediaZoom,
  storyMediaRotate,
  timedTexts,
  storyDrawStrokes,
  storyFilterId,
  storyFilterAdjustments,
  storyMentions,
  fetchStories,
  setUploading,
  setUploadProgress,
  setStoryFile,
  setReshareStory,
  setReshareScaledDown,
  setCaption,
  setTimedTexts,
  setStoryDrawStrokes,
  setStoryDrawingOpen,
  activeStoryDrawStrokeRef,
  setStoryMentions,
  setStoryDurationOpen,
  storyDurationManuallyChosenRef,
  setShowUploadModal,
  setStoryText,
  storySound,
  setStorySound,
}: UseStoryCreationActionsOptions) {
  // إنشاء سجل القصة: يمرر sound_id وزمني اقتصاص الصوت (sound_trim_start/sound_trim_end)
  // مع بقية البيانات في طلب واحد. قاعدة بيانات بترحيل أقدم (بلا أعمدة الصوت) →
  // تنشر القصة بلا الصوت بدل إخفاق النشر كاملاً.
  const createStoryRecord = async (baseArgs: Record<string, unknown>): Promise<{ storyId: string | null; error: { message: string; code?: string } | null }> => {
    if (!storySound) {
      const { data, error } = await supabase.rpc('aani_create_story', baseArgs);
      return { storyId: typeof data === 'string' ? data : null, error: error ? { message: error.message, code: error.code } : null };
    }
    const { data, error } = await supabase.rpc('aani_create_story', {
      ...baseArgs,
      p_sound_id: storySound.soundId,
      p_sound_trim_start: storySound.soundTrim ? Number(storySound.soundTrim.start.toFixed(3)) : null,
      p_sound_trim_end: storySound.soundTrim ? Number(storySound.soundTrim.end.toFixed(3)) : null,
    });
    if (!error) return { storyId: typeof data === 'string' ? data : null, error: null };
    const fallback = await supabase.rpc('aani_create_story', baseArgs);
    if (!fallback.error && typeof fallback.data === 'string') {
      console.warn('[stories] نُشرت القصة بلا الصوت — طبّق ترحيل أعمدة صوت القصص على قاعدة البيانات');
      return { storyId: fallback.data, error: null };
    }
    return { storyId: null, error: error ? { message: error.message, code: error.code } : null };
  };
  const buildStoryTimedTexts = async (
    layers: TimedText[] = timedTexts,
    onProgress?: (percent: number) => void,
    includeMediaTransform = false,
  ): Promise<TimedText[]> => {
    const persistedLayers: TimedText[] = [];
    const imageUploadCount = layers.filter(layer => layer.type === 'image' && Boolean(layer.localFile)).length;
    let imageUploadIndex = 0;
    for (const layer of layers) {
      if (layer.type !== 'image' || !layer.localFile) {
        persistedLayers.push(layer);
        continue;
      }

      const { localFile, ...sticker } = layer;
      const safeName = localFile.name.replace(/[^a-zA-Z0-9._-]/g, '-');
      const filePath = `${userId}/story-sticker-${layer.id}-${Date.now()}-${safeName}`;
      await uploadStoryMedia({
        file: localFile,
        path: filePath,
        preset: 'feedImage',
        onProgress: percent => onProgress?.(
          10 + Math.round(((imageUploadIndex + percent / 100) / imageUploadCount) * 65),
        ),
      });
      imageUploadIndex += 1;
      const src = supabase.storage.from(storageBucket).getPublicUrl(filePath).data.publicUrl;
      persistedLayers.push({ ...sticker, src });
    }

    const mediaTransform: StoryMediaTransformOverlay = {
      id: 'story-media-transform',
      type: 'media-transform',
      startTime: 0,
      endTime: uploadDuration,
      x: Math.min(100, Math.max(-100, (storyMediaOffset.x / Math.max(1, window.innerWidth)) * 100)),
      y: Math.min(100, Math.max(-100, (storyMediaOffset.y / Math.max(1, window.innerHeight)) * 100)),
      scale: storyMediaZoom,
      rotation: storyMediaRotate,
    };
    // بعد القص الحقيقي تُصفَّر التحويلات، فلا داعي لحفظ تحويل مطابق للهوية
    // يُعاد تطبيقه على الصورة المقصوصة في العارض.
    const hasNonIdentityMediaTransform = mediaTransform.x !== 0
      || mediaTransform.y !== 0
      || mediaTransform.scale !== 1
      || mediaTransform.rotation !== 0;
    const allLayers: TimedText[] = [
      ...(includeMediaTransform && hasNonIdentityMediaTransform ? [mediaTransform] : []),
      ...persistedLayers,
      ...(storyDrawStrokes.length > 0
        ? [{
            id: 'story-drawing',
            type: 'drawing' as const,
            startTime: 0,
            endTime: uploadDuration,
            strokes: storyDrawStrokes,
          }]
        : []),
    ];

    return allLayers.map((layer, index) =>
      layer.type === undefined || layer.type === 'text' || layer.type === 'image' || layer.type === 'drawing'
        ? { ...layer, layerOrder: layer.layerOrder ?? index + 10 }
        : layer,
    );
  };

  const linkStoryMentions = async (storyId: string, authorName: string, mentions: MentionCandidate[]) => {
    if (!storyId || mentions.length === 0) return;

    const { error: mentionError } = await supabase.from('story_mentions').insert(
      mentions.map(person => ({ story_id: storyId, author_id: userId, mentioned_id: person.id })),
    );
    if (mentionError) return;

    for (const person of mentions) {
      await supabase.from('notifications').insert({
        user_id: person.id,
        actor_id: userId,
        type: 'mention',
        content: 'قصة جديدة بانتظارك',
        reference_id: storyId,
      });

      const message = {
        sender_id: userId,
        recipient_id: person.id,
        content: `[story:${storyId}] ${STORY_MENTION_CONTENT_MARKER} تمت الإشارة إليك بواسطة ${authorName} في قصته.`,
        story_id: storyId,
      };

      const { error: messageError } = await supabase.from('messages').insert(message);
      if (messageError) {
        // توافق مع قاعدة بيانات لم يُضَف إليها عمود story_id بعد
        const { story_id, ...legacyMessage } = message;
        void story_id;
        await supabase.from('messages').insert(legacyMessage);
      }
    }
  };

  // صورة مصغرة ثابتة للستوري: صورة الفيديو الأولى إن كان فيديو، وإلا صورة
  // الستوري نفسها. عند إعادة المشاركة نُعيد استخدام مصغرة الأصل إن وُجدت.
  const buildStoryThumbnail = async (
    file: File | null,
    mediaUrl: string,
    source: StoryDmCardStory | null,
  ): Promise<string | null> => {
    if (source) return source.thumbnail_url ?? source.media_url ?? null;
    if (!file) return mediaUrl || null;
    if (!file.type.startsWith('video')) return mediaUrl || null;

    try {
      const poster = await createVideoPoster(file);
      const extension = poster.name.split('.').pop() || 'jpg';
      const path = `${userId}/story-thumb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
      await uploadStoryMedia({ file: poster, path, preset: 'storyImage' });
      return supabase.storage.from(storageBucket).getPublicUrl(path).data.publicUrl;
    } catch (error) {
      console.warn('[stories] تعذر إنشاء صورة مصغرة للفيديو:', error);
      return null;
    }
  };

  const saveStoryThumbnail = async (storyId: string, thumbnailUrl: string | null) => {
    if (!storyId || !thumbnailUrl) return;
    const { error } = await supabase.rpc('aani_set_story_thumbnail', {
      p_story_id: storyId,
      p_thumbnail_url: thumbnailUrl,
    });
    if (error) console.warn('[stories] تعذر حفظ الصورة المصغرة للستوري:', error);
  };

  const handleUploadStory = async () => {
    // إيقاف معاينة الصوت فوراً لحظة النقر على نشر
    stopInstant();
    if (!supabaseConfigured) return;
    const sourceStory = storyFile ? null : reshareStory;
    const originalStoryId = liveReshareStoryId(sourceStory);
    if (!storyFile && !caption.trim() && !sourceStory?.media_url) return;

    setUploading(true);
    try {
      let mediaUrl = sourceStory?.media_url || '';
      // 'image' هي القيمة القياسية في قيد stories_media_type_check بقواعد
      // fresh_schema — 'photo' يرفضه القيد القديم؛ العرض يتعامل مع القيمتين
      let mediaType = sourceStory?.media_type === 'video' ? 'video' : sourceStory ? 'image' : 'text';

      if (storyFile) {
        const safeName = storyFile.name.replace(/[^a-zA-Z0-9._-]/g, '-');
        const filePath = `${userId}/story-${Date.now()}-${safeName}`;
        // صور القصص: 1080×1920 كحد أقصى + مستهدف 350KB (الفيديو يُعامل كفيديو)
        await uploadStoryMedia({ file: storyFile, path: filePath, preset: 'storyImage' });
        mediaUrl = supabase.storage.from(storageBucket).getPublicUrl(filePath).data.publicUrl;
        mediaType = storyFile.type.startsWith('video') ? 'video' : 'photo';
      }

      const created = await createStoryRecord({
        p_media_url: mediaUrl || null,
        p_media_type: mediaType,
        p_caption: caption.trim() || sourceStory?.caption || null,
        p_is_close_friends: isCloseFriendsOnly,
        p_duration_seconds: uploadDuration,
        p_timed_texts: await buildStoryTimedTexts(timedTexts, undefined, true),
        p_filter_key: encodeStoryFilterKey(storyFilterId, storyFilterAdjustments),
        p_original_story_id: originalStoryId,
        p_share_type: originalStoryId ? 'reshare' : 'original',
        p_expiry_seconds: null,
      });
      if (created.error) {
        const publishError = new Error(created.error.message) as Error & { code?: string };
        publishError.code = created.error.code;
        throw publishError;
      }
      const storyId = created.storyId;
      if (!storyId) throw new Error('لم تُرجع قاعدة البيانات معرّف القصة المنشورة.');

      await saveStoryThumbnail(storyId, await buildStoryThumbnail(storyFile, mediaUrl, sourceStory));

      if (storyMentions.length > 0) {
        void linkStoryMentions(storyId, currentProfile?.username || '', storyMentions);
      }

      setStoryFile(null);
      setReshareStory(null);
      setReshareScaledDown(false);
      setCaption('');
      setTimedTexts([]);
      setStoryDrawStrokes([]);
      setStoryDrawingOpen(false);
      activeStoryDrawStrokeRef.current = null;
      setStoryMentions([]);
      setStoryDurationOpen(false);
      storyDurationManuallyChosenRef.current = false;
      // توقف معاينة الصوت وأفرغه بعد النشر
      stopInstant();
      setStorySound(null);
      setShowUploadModal(false);
      await fetchStories();
    } catch (err) {
      // نافذة التشخيص: المرحلة + الرسالة الخام + زر النسخ (إضافة دون تغيير السلوك)
      reportMediaStageFailure('فشل نشر القصة (من كود النشر)', {
        rawResponse: err instanceof Error ? err.message : String(err),
      });
      alert(err instanceof Error ? err.message : 'تعذر نشر القصة.');
    } finally {
      setUploading(false);
    }
  };

  const handleQuickPublishStory = (closeFriends: boolean) => {
    // إيقاف معاينة الصوت فوراً لحظة النقر على «قصتك» أو «الأصدقاء المقربون»
    stopInstant();
    const mediaFile = storyFile;
    const sourceStory = mediaFile ? null : reshareStory;
    const originalStoryId = liveReshareStoryId(sourceStory);
    const storyCaption = caption.trim();
    const mentions = [...storyMentions];
    const durationSeconds = uploadDuration;
    if (!supabaseConfigured || (!mediaFile && !sourceStory?.media_url)) return;

    // إغلاق المحرر أولاً، ثم متابعة الرفع دون حجب التفاعل مع الصفحة الرئيسية.
    setShowUploadModal(false);
    setUploading(true);
    setUploadProgress(0);

    void (async () => {
      try {
        let mediaUrl = sourceStory?.media_url || '';
        // 'image' بدل 'photo' — القيمة المقبولة في قيد stories_media_type_check
        let mediaType = sourceStory?.media_type === 'video' ? 'video' : 'image';

        if (mediaFile) {
          const safeName = mediaFile.name.replace(/[^a-zA-Z0-9._-]/g, '-');
          const filePath = `${userId}/story-${Date.now()}-${safeName}`;
          await uploadStoryMedia({
            file: mediaFile,
            path: filePath,
            preset: 'storyImage',
            onProgress: setUploadProgress,
          });
          mediaUrl = supabase.storage.from(storageBucket).getPublicUrl(filePath).data.publicUrl;
          mediaType = mediaFile.type.startsWith('video') ? 'video' : 'photo';
        } else {
          setUploadProgress(85);
        }

        const created = await createStoryRecord({
          p_media_url: mediaUrl || null,
          p_media_type: mediaType,
          p_caption: storyCaption || sourceStory?.caption || null,
          p_is_close_friends: closeFriends,
          p_duration_seconds: durationSeconds,
          p_timed_texts: await buildStoryTimedTexts(timedTexts, undefined, true),
          p_filter_key: encodeStoryFilterKey(storyFilterId, storyFilterAdjustments),
          p_original_story_id: originalStoryId,
          p_share_type: originalStoryId ? 'reshare' : 'original',
          p_expiry_seconds: null,
        });
        if (created.error) {
          const publishError = new Error(created.error.message) as Error & { code?: string };
          publishError.code = created.error.code;
          throw publishError;
        }
        const storyId = created.storyId;
        if (storyId) {
          await saveStoryThumbnail(storyId, await buildStoryThumbnail(mediaFile, mediaUrl, sourceStory));
        }
        if (storyId && mentions.length > 0) {
          void linkStoryMentions(storyId, currentProfile?.username || '', mentions);
        }

        setStoryFile(current => current === mediaFile ? null : current);
        setReshareStory(null);
        setReshareScaledDown(false);
        setCaption(current => current.trim() === storyCaption ? '' : current);
        setStoryText('');
        setTimedTexts([]);
        setStoryDrawStrokes([]);
        setStoryDrawingOpen(false);
        activeStoryDrawStrokeRef.current = null;
        setStoryMentions([]);
        setStoryDurationOpen(false);
        storyDurationManuallyChosenRef.current = false;
        // توقف معاينة الصوت وأفرغه بعد النشر
        stopInstant();
        setStorySound(null);
        await fetchStories();
        toast.success('تم نشر القصة بنجاح', { duration: 5000 });
      } catch (error) {
        console.error('Story publish failed:', error);
        const errorInfo = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown } : null;
        const details = error instanceof Error
          ? error.message
          : String(errorInfo?.message || '');
        // نافذة التشخيص: المرحلة + الرسالة الخام + زر النسخ (إضافة دون تغيير السلوك)
        reportMediaStageFailure('فشل نشر القصة (من كود النشر)', { rawResponse: details });
        const errorCode = String(errorInfo?.code || '');
        if (errorCode === 'PGRST202' || /aani_create_story|function.*not found|PGRST202/i.test(details)) {
          toast.error('حدّث قاعدة البيانات بتشغيل ترحيل القصص ثم أعد المحاولة');
        } else if (errorCode === '42501' || /row-level security|permission denied/i.test(details)) {
          toast.error('رفضت صلاحيات قاعدة البيانات نشر القصة. تأكد من تطبيق تحديث الخصوصية والقصص.');
        } else {
          toast.error(details ? `تعذر نشر القصة: ${details}` : 'تعذر نشر القصة، حاول مرة أخرى');
        }
        setShowUploadModal(true);
      } finally {
        setUploading(false);
        setUploadProgress(0);
      }
    })();
  };

  const handleCreateTextStory = async (
    text: string,
    canvasStyle: StoryCanvasStyle,
    textLayers: TimedText[],
    closeFriends = isCloseFriendsOnly,
  ): Promise<boolean> => {
    // إيقاف معاينة الصوت فوراً لحظة النقر على نشر
    stopInstant();
    const layerText = textLayers
      .filter((layer): layer is StoryTextOverlay => layer.type === undefined || layer.type === 'text')
      .map(layer => layer.text.trim())
      .filter(Boolean)
      .join('\n');
    const trimmedText = layerText || text.trim();
    const hasImageSticker = textLayers.some(layer => layer.type === 'image');
    if ((!trimmedText && !hasImageSticker) || !supabaseConfigured) return false;

    setUploading(true);
    setUploadProgress(5);
    try {
      const persistedTextLayers = await buildStoryTimedTexts(textLayers, setUploadProgress);
      setUploadProgress(85);
      const timedTexts = [
        {
          id: 'story-canvas-style',
          type: 'canvas-style' as const,
          startTime: 0,
          endTime: uploadDuration,
          ...canvasStyle,
          background: canvasStyle.background || '#000000',
        },
        ...persistedTextLayers,
      ];
      const created = await createStoryRecord({
        p_media_url: null,
        p_media_type: 'text',
        p_caption: trimmedText || null,
        p_is_close_friends: closeFriends,
        p_duration_seconds: uploadDuration,
        p_timed_texts: timedTexts,
        p_filter_key: encodeStoryFilterKey(storyFilterId, storyFilterAdjustments),
        p_original_story_id: null,
        p_share_type: 'original',
        p_expiry_seconds: null,
      });

      if (created.error) {
        const publishError = new Error(created.error.message) as Error & { code?: string };
        publishError.code = created.error.code;
        throw publishError;
      }
      const storyId = created.storyId;
      if (!storyId) throw new Error('لم تُرجع قاعدة البيانات معرّف القصة المنشورة.');

      if (storyMentions.length > 0) {
        void linkStoryMentions(storyId, currentProfile?.username || '', storyMentions);
      }

      setUploadProgress(100);
      setCaption('');
      setStoryText('');
      setTimedTexts([]);
      setStoryDrawStrokes([]);
      setStoryDrawingOpen(false);
      activeStoryDrawStrokeRef.current = null;
      setStoryMentions([]);
      setStoryDurationOpen(false);
      storyDurationManuallyChosenRef.current = false;
      // توقف معاينة الصوت وأفرغه بعد النشر
      stopInstant();
      setStorySound(null);
      setShowUploadModal(false);
      void fetchStories().catch(error => console.warn('[stories] تعذر تحديث القصص بعد النشر:', error));
      return true;
    } catch (error) {
      console.error('[text story publish] تعذر حفظ القصة:', error);
      const errorInfo = error && typeof error === 'object'
        ? error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown }
        : null;
      const details = error instanceof Error
        ? error.message
        : [errorInfo?.message, errorInfo?.details, errorInfo?.hint]
          .filter((value): value is string => typeof value === 'string' && value.length > 0)
          .join(' — ');
      // نافذة التشخيص: المرحلة + الرسالة الخام + زر النسخ (إضافة دون تغيير السلوك)
      reportMediaStageFailure('فشل نشر القصة (من كود النشر)', { rawResponse: details });
      const errorCode = String(errorInfo?.code || '');
      if (errorCode === 'PGRST202' || /aani_create_story|function.*not found|schema cache/i.test(details)) {
        toast.error('قاعدة البيانات لا تحتوي على إجراء نشر القصص المطلوب. طبّق آخر ترحيلات القصص في Supabase ثم أعد المحاولة.');
      } else if (errorCode === '42501' || /row-level security|permission denied|not allowed/i.test(details)) {
        toast.error('رفضت صلاحيات قاعدة البيانات نشر القصة. تحقّق من ترحيلات صلاحيات القصص في Supabase.');
      } else {
        toast.error(details ? `تعذر نشر القصة: ${details}` : 'تعذر نشر القصة، تحقق من الاتصال ثم أعد المحاولة');
      }
      return false;
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  return { handleUploadStory, handleQuickPublishStory, handleCreateTextStory };
}

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { toast } from 'sonner';

import type { StoryDrawStroke } from '@/lib/appShared';
import type { StoryCanvasStyle, StoryTextOverlay, StoryTimedText } from '@/components/stories/types';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { uploadStoryMedia } from '@/lib/storyUpload';
import type { Profile } from '@/lib/types';
import { encodeStoryFilterKey, type StoryAdjustments } from '@/lib/storyFilters';
import type { StoryRow as StoryDmCardStory } from '../StoryDmCard';
import type { MentionCandidate } from '../StoryMentionPicker';

type TimedText = StoryTimedText;

interface UseStoryCreationActionsOptions {
  userId: string;
  currentProfile: Profile | null;
  storyFile: File | null;
  reshareStory: StoryDmCardStory | null;
  caption: string;
  isCloseFriendsOnly: boolean;
  uploadDuration: number;
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
}

export function useStoryCreationActions({
  userId,
  currentProfile,
  storyFile,
  reshareStory,
  caption,
  isCloseFriendsOnly,
  uploadDuration,
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
}: UseStoryCreationActionsOptions) {
  const buildStoryTimedTexts = async (
    layers: TimedText[] = timedTexts,
    onProgress?: (percent: number) => void,
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
        onProgress: percent => onProgress?.(
          10 + Math.round(((imageUploadIndex + percent / 100) / imageUploadCount) * 65),
        ),
      });
      imageUploadIndex += 1;
      const src = supabase.storage.from(storageBucket).getPublicUrl(filePath).data.publicUrl;
      persistedLayers.push({ ...sticker, src });
    }

    return [
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
        content: `[story:${storyId}] تمت الإشارة إليك بواسطة ${authorName} في قصته.`,
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

  const handleUploadStory = async () => {
    if (!supabaseConfigured) return;
    const sourceStory = storyFile ? null : reshareStory;
    if (!storyFile && !caption.trim() && !sourceStory?.media_url) return;

    setUploading(true);
    try {
      let mediaUrl = sourceStory?.media_url || '';
      let mediaType = sourceStory?.media_type === 'video' ? 'video' : sourceStory ? 'photo' : 'text';

      if (storyFile) {
        const safeName = storyFile.name.replace(/[^a-zA-Z0-9._-]/g, '-');
        const filePath = `${userId}/story-${Date.now()}-${safeName}`;
        const { error: uploadErr } = await supabase.storage.from(storageBucket).upload(filePath, storyFile, { contentType: storyFile.type, upsert: true });
        if (uploadErr) throw uploadErr;
        mediaUrl = supabase.storage.from(storageBucket).getPublicUrl(filePath).data.publicUrl;
        mediaType = storyFile.type.startsWith('video') ? 'video' : 'photo';
      }

      const { data: storyId, error: insertError } = await supabase.rpc('aani_create_story', {
        p_media_url: mediaUrl || null,
        p_media_type: mediaType,
        p_caption: caption.trim() || sourceStory?.caption || null,
        p_is_close_friends: isCloseFriendsOnly,
        p_duration_seconds: uploadDuration,
        p_timed_texts: await buildStoryTimedTexts(),
        p_filter_key: encodeStoryFilterKey(storyFilterId, storyFilterAdjustments),
        p_original_story_id: sourceStory?.id || null,
        p_share_type: sourceStory ? 'reshare' : 'original',
        p_expiry_seconds: null,
      });
      if (insertError) throw insertError;
      if (typeof storyId !== 'string') throw new Error('لم تُرجع قاعدة البيانات معرّف القصة المنشورة.');

      if (storyMentions.length > 0) {
        void linkStoryMentions(storyId, currentProfile?.username || 'مستخدم', storyMentions);
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
      setShowUploadModal(false);
      await fetchStories();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'تعذر نشر القصة.');
    } finally {
      setUploading(false);
    }
  };

  const handleQuickPublishStory = (closeFriends: boolean) => {
    const mediaFile = storyFile;
    const sourceStory = mediaFile ? null : reshareStory;
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
        let mediaType = sourceStory?.media_type === 'video' ? 'video' : 'photo';

        if (mediaFile) {
          const safeName = mediaFile.name.replace(/[^a-zA-Z0-9._-]/g, '-');
          const filePath = `${userId}/story-${Date.now()}-${safeName}`;
          await uploadStoryMedia({
            file: mediaFile,
            path: filePath,
            onProgress: setUploadProgress,
          });
          mediaUrl = supabase.storage.from(storageBucket).getPublicUrl(filePath).data.publicUrl;
          mediaType = mediaFile.type.startsWith('video') ? 'video' : 'photo';
        } else {
          setUploadProgress(85);
        }

        const { data: storyId, error: insertError } = await supabase.rpc('aani_create_story', {
          p_media_url: mediaUrl || null,
          p_media_type: mediaType,
          p_caption: storyCaption || sourceStory?.caption || null,
          p_is_close_friends: closeFriends,
          p_duration_seconds: durationSeconds,
          p_timed_texts: await buildStoryTimedTexts(),
          p_filter_key: encodeStoryFilterKey(storyFilterId, storyFilterAdjustments),
          p_original_story_id: sourceStory?.id || null,
          p_share_type: sourceStory ? 'reshare' : 'original',
          p_expiry_seconds: null,
        });

        if (insertError) throw insertError;
        if (typeof storyId === 'string' && mentions.length > 0) {
          void linkStoryMentions(storyId, currentProfile?.username || 'مستخدم', mentions);
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
        await fetchStories();
        toast.success('تم نشر القصة بنجاح', { duration: 5000 });
      } catch (error) {
        console.error('Story publish failed:', error);
        const errorInfo = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown } : null;
        const details = error instanceof Error
          ? error.message
          : String(errorInfo?.message || '');
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
      const { data: storyId, error } = await supabase.rpc('aani_create_story', {
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

      if (error) throw error;
      if (typeof storyId !== 'string') throw new Error('لم تُرجع قاعدة البيانات معرّف القصة المنشورة.');

      if (storyMentions.length > 0) {
        void linkStoryMentions(storyId, currentProfile?.username || 'مستخدم', storyMentions);
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

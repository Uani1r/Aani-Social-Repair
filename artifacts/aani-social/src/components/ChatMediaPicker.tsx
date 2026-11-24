import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { Album, Check, Eye, Images, LoaderCircle, Pencil, Send, X, Video, Film } from 'lucide-react';
import { toast } from 'sonner';

import ChatPhotoEditor from '@/components/ChatPhotoEditor';
import ChatVideoRecorder from '@/components/ChatVideoRecorder';
import { CHAT_MEDIA_MESSAGE_PREFIX } from '@/components/ChatImageMessage';
import { chatVideoMessageContent } from '@/lib/chatVideo';
import { prepareChatVideo } from '@/lib/chatVideoCompression';
import { sendChatMediaSelection } from '@/lib/chatVideoSend';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { uploadMedia } from '@/lib/storyUpload';
import { readLocalUserPreferences } from '@/lib/userPreferences';

type GalleryMedia = { id: string; file: File; url: string; type: 'image' | 'video' };
type PickerTab = 'photos' | 'videos' | 'albums' | 'camera';

export type PendingChatMediaMessage = {
  id: string;
  recipientId: string;
  urls: string[];
  caption: string;
  viewOnce: boolean;
  createdAt: string;
  isUploading: boolean;
};

type ChatMediaPickerProps = {
  currentUserId: string;
  recipientId: string | null | undefined;
  onSendStart?: (message: PendingChatMediaMessage) => void;
  onUploaded?: (pendingId: string, recipientId: string, urls: string[]) => void;
  onSent?: (pendingId: string, recipientId: string) => void | Promise<void>;
  onSendFailed?: (pendingId: string) => void;
};

const MAX_SELECTED_MEDIA = 10;

function notifyCaptionChange(caption: string): void {
  window.dispatchEvent(new CustomEvent('aani-chat-media-caption-update', { detail: { caption } }));
}

export default function ChatMediaPicker({
  currentUserId,
  recipientId,
  onSendStart,
  onUploaded,
  onSent,
  onSendFailed,
}: ChatMediaPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<PickerTab>('photos');
  const [mediaItems, setMediaItems] = useState<GalleryMedia[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [caption, setCaption] = useState('');
  const [viewOnce, setViewOnce] = useState(false);
  const [hd, setHd] = useState(() => readLocalUserPreferences(currentUserId).mediaQuality === 'hd');
  const [activeRecipientId, setActiveRecipientId] = useState<string | null>(recipientId || null);
  const [recordingVideo, setRecordingVideo] = useState(false);
  const [sending, setSending] = useState(false);
  const recipientIdRef = useRef(recipientId);
  useEffect(() => { recipientIdRef.current = recipientId; }, [recipientId]);
  const [editingPhotoId, setEditingPhotoId] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const objectUrlsRef = useRef(new Set<string>());
  // منع تكرار إرسال الفيديو المسجل (نقرة مزدوجة أو استدعاء متزامن).
  const videoSendInFlightRef = useRef(false);
  // روابط الفيديوهات (الاستوديو) المرفوعة مسبقاً لكل عنصر — تُعاد استخدامها عند إعادة المحاولة.
  const uploadedVideoUrlsRef = useRef(new Map<string, string>());

  const selectedMedia = useMemo(() => mediaItems.filter(item => selectedIds.includes(item.id)), [mediaItems, selectedIds]);
  const editingPhoto = mediaItems.find(item => item.id === editingPhotoId) || null;

  useEffect(() => () => {
    objectUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    objectUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      if (sending || recordingVideo) {
        toast.info('جارٍ إرسال الوسائط...');
        return;
      }
      const detail = (event as CustomEvent<{ caption?: string; recipientId?: string }>).detail;
      setCaption(detail?.caption || '');
      setActiveRecipientId(detail?.recipientId || recipientIdRef.current || null);
      setHd(readLocalUserPreferences(currentUserId).mediaQuality === 'hd');
      setActiveTab('photos');
      setOpen(true);
    };
    window.addEventListener('aani-open-chat-media-picker', handleOpen);
    return () => window.removeEventListener('aani-open-chat-media-picker', handleOpen);
  }, [currentUserId, sending, recordingVideo]);

  const openImagePicker = () => imageInputRef.current?.click();
  const openVideoPicker = () => videoInputRef.current?.click();

  const addFiles = (event: ChangeEvent<HTMLInputElement>, acceptType: 'image' | 'video') => {
    const files = Array.from(event.currentTarget.files || []).filter(file =>
      acceptType === 'image' ? file.type.startsWith('image/') : file.type.startsWith('video/')
    );
    event.currentTarget.value = '';
    if (!files.length) {
      toast.info(acceptType === 'image' ? 'اختر صورة بصيغة مدعومة.' : 'اختر فيديو بصيغة مدعومة.');
      return;
    }

    const availableSlots = MAX_SELECTED_MEDIA - selectedIds.length;
    if (files.length > availableSlots) {
      toast.info(`يمكن تحديد ${MAX_SELECTED_MEDIA} عناصر كحد أقصى.`);
    }
    const addedMedia = files.slice(0, Math.max(0, availableSlots)).map((file, index) => {
      const url = URL.createObjectURL(file);
      objectUrlsRef.current.add(url);
      return {
        id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        url,
        type: acceptType,
      };
    });

    if (!addedMedia.length) return;
    setMediaItems(current => [...current, ...addedMedia]);
    setSelectedIds(current => [...current, ...addedMedia.map(item => item.id)]);
  };

  const addImages = (event: ChangeEvent<HTMLInputElement>) => addFiles(event, 'image');
  const addVideos = (event: ChangeEvent<HTMLInputElement>) => addFiles(event, 'video');

  const toggleMedia = (id: string) => {
    setSelectedIds(current => {
      if (current.includes(id)) return current.filter(selectedId => selectedId !== id);
      if (current.length >= MAX_SELECTED_MEDIA) {
        toast.info(`يمكن تحديد ${MAX_SELECTED_MEDIA} عناصر كحد أقصى.`);
        return current;
      }
      return [...current, id];
    });
  };

  const closePicker = () => {
    setOpen(false);
    setEditingPhotoId(null);
    uploadedVideoUrlsRef.current.clear();
    notifyCaptionChange(caption);
  };

  const replaceEditedPhoto = (id: string, file: File) => {
    const previousPhoto = mediaItems.find(item => item.id === id);
    if (previousPhoto) {
      URL.revokeObjectURL(previousPhoto.url);
      objectUrlsRef.current.delete(previousPhoto.url);
    }
    const url = URL.createObjectURL(file);
    objectUrlsRef.current.add(url);
    setMediaItems(current => current.map(item => item.id === id ? { ...item, file, url } : item));
    setEditingPhotoId(null);
  };

  const sendSelectedMedia = async () => {
    if (sending || selectedMedia.length === 0) return;
    if (!activeRecipientId || !supabaseConfigured) {
      toast.error('تعذر إرسال الوسائط لأن المحادثة أو قاعدة البيانات غير جاهزة.');
      return;
    }

    const recipientIdSnapshot = activeRecipientId;
    const selectedMediaSnapshot = selectedMedia;
    const mediaSnapshot = mediaItems;
    const captionSnapshot = caption.trim();
    const viewOnceSnapshot = viewOnce;
    const hdSnapshot = hd;
    const localUrls: string[] = [];
    try {
      selectedMediaSnapshot.forEach(item => {
        const url = URL.createObjectURL(item.file);
        localUrls.push(url);
        objectUrlsRef.current.add(url);
      });
    } catch (error) {
      localUrls.forEach(url => {
        URL.revokeObjectURL(url);
        objectUrlsRef.current.delete(url);
      });
      console.error('[messages] تعذر تجهيز معاينة الوسائط المحلية:', error);
      toast.error('تعذر عرض معاينة الوسائط. حاول اختيارها مرة أخرى.');
      return;
    }
    const releaseLocalUrls = () => localUrls.forEach(url => {
      URL.revokeObjectURL(url);
      objectUrlsRef.current.delete(url);
    });
    const pendingMessage: PendingChatMediaMessage = {
      id: `pending-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      recipientId: recipientIdSnapshot,
      urls: localUrls,
      caption: captionSnapshot,
      viewOnce: viewOnceSnapshot,
      createdAt: new Date().toISOString(),
      isUploading: true,
    };

    setSending(true);
    setOpen(false);
    setEditingPhotoId(null);
    notifyCaptionChange('');
    onSendStart?.(pendingMessage);

    try {
      // الصور على مسارها القديم، والفيديو يمرّ عبر prepareChatVideo (ضغط + تحقق)
      // قبل أي رفع، ثم يُرفع الملف المضغوط وحده ويُنشأ في رسالة فيديو مستقلة.
      const result = await sendChatMediaSelection(
        selectedMediaSnapshot.map(item => ({ id: item.id, type: item.type, file: item.file })),
        {
          imageMessagePrefix: CHAT_MEDIA_MESSAGE_PREFIX,
          caption: captionSnapshot,
          viewOnce: viewOnceSnapshot,
          prepareVideo: file => prepareChatVideo(file),
          uploadImage: async (item, index) => {
            const safeName = item.file.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-80) || 'photo.jpg';
            const path = `${currentUserId}/messages/${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
            await uploadMedia({ file: item.file, path, preset: 'chatImage', quality: hdSnapshot ? 'hd' : 'data-saving' });
            return supabase.storage.from(storageBucket).getPublicUrl(path).data.publicUrl;
          },
          uploadVideo: async (item, prepared) => {
            const cached = uploadedVideoUrlsRef.current.get(item.id);
            if (cached) return cached;
            if (!prepared.file) throw new Error('الملف المضغوط مفقود.');
            const path = `${currentUserId}/messages/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-video.mp4`;
            const url = await uploadMedia({ file: prepared.file, path, preset: 'video' });
            uploadedVideoUrlsRef.current.set(item.id, url);
            return url;
          },
          uploadPoster: async (_item, posterFile) => {
            const path = `${currentUserId}/messages/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-poster.jpg`;
            return await uploadMedia({ file: posterFile, path, preset: 'chatImage' });
          },
          insertMessage: async content => {
            if (content.length > 4000) throw new Error('حجم بيانات الوسائط كبير جداً. قلل عدد العناصر وحاول مرة أخرى.');
            const { error } = await supabase.from('messages').insert({
              sender_id: currentUserId,
              recipient_id: recipientIdSnapshot,
              content,
            });
            if (error) throw error;
          },
        },
      );

      if (result.failedVideos.length) {
        result.failedVideos.forEach(failure => toast.error(failure.message));
      }

      const imageIds = selectedMediaSnapshot.filter(item => item.type === 'image').map(item => item.id);
      const videoIds = selectedMediaSnapshot.filter(item => item.type === 'video').map(item => item.id);
      const sentIds = new Set([
        ...imageIds.slice(0, result.imageUrls.length),
        ...videoIds.slice(0, result.videoUrls.length),
      ]);
      if (!result.ok && sentIds.size === 0) throw new Error(result.message);

      onUploaded?.(pendingMessage.id, recipientIdSnapshot, [...result.imageUrls, ...result.videoUrls]);
      await new Promise(resolve => window.setTimeout(resolve, 200));
      await onSent?.(pendingMessage.id, recipientIdSnapshot);
      releaseLocalUrls();

      // ما أُرسل فعلاً يُزال من التحديد، وما فشل يبقى لإعادة المحاولة دون تكرار.
      mediaSnapshot.forEach(item => {
        if (!sentIds.has(item.id)) return;
        URL.revokeObjectURL(item.url);
        objectUrlsRef.current.delete(item.url);
        uploadedVideoUrlsRef.current.delete(item.id);
      });
      setMediaItems(current => current.filter(item => !sentIds.has(item.id)));
      setSelectedIds(current => current.filter(id => !sentIds.has(id)));
      if (result.failedVideos.length === 0 && result.ok) {
        setCaption('');
        setViewOnce(false);
        uploadedVideoUrlsRef.current.clear();
        notifyCaptionChange('');
        toast.success('تم إرسال الوسائط');
      } else {
        notifyCaptionChange(captionSnapshot);
      }
    } catch (error) {
      releaseLocalUrls();
      onSendFailed?.(pendingMessage.id);
      notifyCaptionChange(captionSnapshot);
      console.error('[messages] تعذر إرسال الوسائط:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر إرسال الوسائط. تحقق من الاتصال وحاول مرة أخرى.');
    } finally {
      setSending(false);
    }
  };

  const handleVideoRecorded = async (videoUrl: string, durationSeconds: number, viewOnceRecorded: boolean): Promise<boolean> => {
    if (!activeRecipientId || !supabaseConfigured) {
      toast.error('تعذر إرسال الفيديو لأن المحادثة غير جاهزة.');
      return false;
    }
    // منع تكرار الرسالة إذا كان هناك إرسال جارٍ بالفعل
    if (videoSendInFlightRef.current) return false;

    const recipientIdSnapshot = activeRecipientId;
    const captionSnapshot = caption.trim();
    const viewOnceSnapshot = viewOnceRecorded;
    const pendingMessage: PendingChatMediaMessage = {
      id: `pending-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      recipientId: recipientIdSnapshot,
      urls: [videoUrl],
      caption: captionSnapshot,
      viewOnce: viewOnceSnapshot,
      createdAt: new Date().toISOString(),
      isUploading: true,
    };

    videoSendInFlightRef.current = true;
    setSending(true);
    notifyCaptionChange('');
    onSendStart?.(pendingMessage);
    let messageInserted = false;
    try {
      // فيديو الكاميرا يُرسل كرسالة فيديو (لا كصورة) ليفتحه ChatVideoMessage نفسه.
      const content = chatVideoMessageContent({
        url: videoUrl,
        durationMs: Math.max(0, Math.round(durationSeconds * 1000)),
        posterUrl: null,
        caption: captionSnapshot,
        viewOnce: viewOnceSnapshot,
        width: 0,
        height: 0,
      });
      const { error } = await supabase.from('messages').insert({
        sender_id: currentUserId,
        recipient_id: recipientIdSnapshot,
        content,
      });
      if (error) throw error;
      messageInserted = true;
      onUploaded?.(pendingMessage.id, recipientIdSnapshot, [videoUrl]);
      await new Promise(resolve => window.setTimeout(resolve, 200));
      await onSent?.(pendingMessage.id, recipientIdSnapshot);
      setCaption('');
      setViewOnce(false);
      notifyCaptionChange('');
      // نجاح فعلي: أعد المستخدم إلى منتقي الوسائط وأغلق وضع التسجيل
      setRecordingVideo(false);
      toast.success('تم إرسال الفيديو');
      return true;
    } catch (error) {
      if (messageInserted) {
        // الرسالة أُدرجت بالفعل؛ لا نعيد الإرسال (لمنع التكرار) ونعتبر العملية نجاحاً
        setCaption('');
        setViewOnce(false);
        notifyCaptionChange('');
        setRecordingVideo(false);
        toast.success('تم إرسال الفيديو');
        return true;
      }
      // فشل الإدراج: أبقِ المعاينة مفتوحة للسماح بإعادة المحاولة دون إعلان نجاح
      onSendFailed?.(pendingMessage.id);
      notifyCaptionChange(captionSnapshot);
      console.error('[messages] تعذر إرسال الفيديو المسجل:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر إرسال الفيديو. حاول مرة أخرى.');
      return false;
    } finally {
      videoSendInFlightRef.current = false;
      setSending(false);
    }
  };

  const handleCancelVideoRecording = () => {
    setRecordingVideo(false);
  };

  if (!open) return null;

  return createPortal(
    <>
      {!editingPhoto && !recordingVideo ? (
        <section className="chat-media-picker" role="dialog" aria-modal="true" aria-label="اختيار الوسائط" dir="rtl">
          <header className="chat-media-picker-header" dir="ltr">
            <button type="button" className={`chat-media-picker-hd${hd ? ' is-active' : ''}`} aria-pressed={hd} onClick={() => setHd(value => !value)}>
              HD
            </button>
            <button type="button" className="chat-media-picker-hd" onClick={() => videoInputRef.current?.click()} disabled={sending}>
              فيديو
            </button>
            <div className="chat-media-picker-tabs" role="tablist" aria-label="نوع الوسائط">
              <button type="button" role="tab" aria-selected={activeTab === 'photos'} className={activeTab === 'photos' ? 'is-active' : ''} onClick={() => setActiveTab('photos')}>الصور</button>
              <button type="button" role="tab" aria-selected={activeTab === 'videos'} className={activeTab === 'videos' ? 'is-active' : ''} onClick={() => setActiveTab('videos')}>الفيديوهات</button>
              <button type="button" role="tab" aria-selected={activeTab === 'camera'} className={activeTab === 'camera' ? 'is-active' : ''} onClick={() => setRecordingVideo(true)}>
                <Video size={18} />
                <span>الكاميرا</span>
              </button>
              <button type="button" role="tab" aria-selected={activeTab === 'albums'} className={activeTab === 'albums' ? 'is-active' : ''} onClick={() => setActiveTab('albums')}>الألبومات</button>
            </div>
            <button type="button" className="chat-media-picker-close" aria-label="إغلاق منتقي الوسائط" onClick={closePicker}><X size={28} /></button>
          </header>

          {activeTab === 'photos' ? (
            <div className="chat-media-picker-grid" aria-label="الصور المحددة من الجهاز">
              {mediaItems.filter(m => m.type === 'image').map((item, index) => {
                const selectionNumber = selectedIds.indexOf(item.id);
                return (
                  <button key={item.id} type="button" className={`chat-media-picker-photo${selectionNumber >= 0 ? ' is-selected' : ''}`} onClick={() => toggleMedia(item.id)} aria-label={selectionNumber >= 0 ? `إلغاء تحديد الصورة ${index + 1}` : `تحديد الصورة ${index + 1}`} aria-pressed={selectionNumber >= 0}>
                    <img src={item.url} alt={item.file.name || 'صورة من الجهاز'} />
                    <span className="chat-media-picker-number">{selectionNumber >= 0 ? selectionNumber + 1 : ''}</span>
                  </button>
                );
              })}
              <button type="button" className="chat-media-picker-add" onClick={openImagePicker}>
                <Images size={30} />
                <span>{mediaItems.filter(m => m.type === 'image').length ? 'إضافة صور من الجهاز' : 'اختيار صور من الجهاز'}</span>
              </button>
              {mediaItems.filter(m => m.type === 'image').length === 0 && (
                <div className="chat-media-picker-empty">
                  <Images size={36} />
                  <span>اختر صوراً من مكتبة جهازك لعرضها هنا</span>
                  <button type="button" onClick={openImagePicker}>فتح معرض الصور</button>
                </div>
              )}
            </div>
          ) : activeTab === 'videos' ? (
            <div className="chat-media-picker-grid" aria-label="الفيديوهات المحددة من الجهاز">
              {mediaItems.filter(m => m.type === 'video').map((item, index) => {
                const selectionNumber = selectedIds.indexOf(item.id);
                return (
                  <button key={item.id} type="button" className={`chat-media-picker-photo${selectionNumber >= 0 ? ' is-selected' : ''}`} onClick={() => toggleMedia(item.id)} aria-label={selectionNumber >= 0 ? `إلغاء تحديد الفيديو ${index + 1}` : `تحديد الفيديو ${index + 1}`} aria-pressed={selectionNumber >= 0}>
                    <video src={item.url} muted playsInline className="chat-media-picker-video-thumb" />
                    <span className="chat-media-picker-video-duration" aria-label="مدة الفيديو">
                      <Film size={14} />
                      <span id={`video-duration-${item.id}`}>--:--</span>
                    </span>
                    <span className="chat-media-picker-number">{selectionNumber >= 0 ? selectionNumber + 1 : ''}</span>
                  </button>
                );
              })}
              <button type="button" className="chat-media-picker-add" onClick={openVideoPicker}>
                <Video size={30} />
                <span>{mediaItems.filter(m => m.type === 'video').length ? 'إضافة فيديوهات من الجهاز' : 'اختيار فيديوهات من الجهاز'}</span>
              </button>
              {mediaItems.filter(m => m.type === 'video').length === 0 && (
                <div className="chat-media-picker-empty">
                  <Video size={36} />
                  <span>اختر فيديوهات من مكتبة جهازك لعرضها هنا</span>
                  <button type="button" onClick={openVideoPicker}>فتح معرض الفيديو</button>
                </div>
              )}
            </div>
          ) : activeTab === 'albums' ? (
            <div className="chat-media-picker-albums">
              <button type="button" className="chat-media-picker-album" onClick={() => setActiveTab('photos')}>
                <span className="chat-media-picker-album-cover">
                  {mediaItems.filter(m => m.type === 'image').slice(0, 4).map(item => <img key={item.id} src={item.url} alt="" />)}
                  {mediaItems.filter(m => m.type === 'image').length === 0 && <Images size={30} />}
                </span>
                <span><strong>الأخيرة</strong><small>{mediaItems.filter(m => m.type === 'image').length} صور</small></span>
                <Album size={20} />
              </button>
              <button type="button" className="chat-media-picker-add-album" onClick={openImagePicker}><Images size={20} /> إضافة صور من الجهاز</button>
            </div>
          ) : null}

          <input ref={imageInputRef} type="file" accept="image/*" multiple className="chat-media-picker-input" onChange={addImages} />
          <input ref={videoInputRef} type="file" accept="video/*" multiple className="chat-media-picker-input" onChange={addVideos} />

          {selectedMedia.length > 0 && (
            <div className="chat-media-picker-selection" dir="rtl">
              <button type="button" className="chat-media-picker-send" aria-label={`إرسال ${selectedMedia.length} عناصر`} onClick={() => void sendSelectedMedia()} disabled={sending}>
                {sending ? <LoaderCircle size={22} className="chat-media-picker-loading" /> : <Send size={22} fill="currentColor" />}
                <span className="chat-media-picker-send-count">{selectedMedia.length}</span>
              </button>
              <input
                className="chat-media-picker-caption"
                type="text"
                value={caption}
                onChange={event => setCaption(event.target.value)}
                maxLength={1000}
                placeholder="إضافة شرح توضيحي..."
                aria-label="إضافة شرح توضيحي للوسائط"
                dir="rtl"
                disabled={sending}
              />
              <button type="button" className={`chat-media-picker-once${viewOnce ? ' is-active' : ''}`} aria-label="عرض الوسائط مرة واحدة" aria-pressed={viewOnce} onClick={() => setViewOnce(value => !value)} disabled={sending}>
                <Eye size={20} />
                <span>1</span>
              </button>
              {selectedMedia.length === 1 && selectedMedia[0].type === 'image' && (
                <button type="button" className="chat-media-picker-edit" aria-label="تعديل الصورة المحددة" onClick={() => setEditingPhotoId(selectedMedia[0].id)} disabled={sending}>
                  <Pencil size={19} />
                </button>
              )}
            </div>
          )}
        </section>
      ) : recordingVideo ? (
        <ChatVideoRecorder
          currentUserId={currentUserId}
          recipientId={activeRecipientId}
          onRecorded={handleVideoRecorded}
          onCancel={handleCancelVideoRecording}
        />
      ) : editingPhoto ? (
        <ChatPhotoEditor
          file={editingPhoto.file}
          quality={hd ? 0.96 : 0.76}
          onCancel={() => setEditingPhotoId(null)}
          onSave={file => replaceEditedPhoto(editingPhoto.id, file)}
        />
      ) : null}
    </>,
    document.body,
  );
}
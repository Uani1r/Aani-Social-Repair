import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { Album, Check, Eye, Images, LoaderCircle, Pencil, Send, X } from 'lucide-react';
import { toast } from 'sonner';

import ChatPhotoEditor from '@/components/ChatPhotoEditor';
import { CHAT_MEDIA_MESSAGE_PREFIX } from '@/components/ChatImageMessage';
import { supabase, supabaseConfigured, storageBucket } from '@/lib/supabase';
import { uploadMedia } from '@/lib/storyUpload';
import { readLocalUserPreferences } from '@/lib/userPreferences';

type GalleryPhoto = { id: string; file: File; url: string };
type PickerTab = 'photos' | 'albums';

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

const MAX_SELECTED_PHOTOS = 10;

function notifyCaptionChange(caption: string): void {
  window.dispatchEvent(new CustomEvent('aani-chat-media-caption-update', { detail: { caption } }));
}

export default function ChatMediaPicker({ currentUserId, recipientId, onSendStart, onUploaded, onSent, onSendFailed }: ChatMediaPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<PickerTab>('photos');
  const [photos, setPhotos] = useState<GalleryPhoto[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [caption, setCaption] = useState('');
  const [viewOnce, setViewOnce] = useState(false);
  const [hd, setHd] = useState(() => readLocalUserPreferences(currentUserId).mediaQuality === 'hd');
  const [activeRecipientId, setActiveRecipientId] = useState<string | null>(recipientId || null);
  const recipientIdRef = useRef(recipientId);
  useEffect(() => { recipientIdRef.current = recipientId; }, [recipientId]);
  const [editingPhotoId, setEditingPhotoId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const objectUrlsRef = useRef(new Set<string>());

  const selectedPhotos = useMemo(() => photos.filter(photo => selectedIds.includes(photo.id)), [photos, selectedIds]);
  const editingPhoto = photos.find(photo => photo.id === editingPhotoId) || null;

  useEffect(() => () => {
    objectUrlsRef.current.forEach(url => URL.revokeObjectURL(url));
    objectUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      if (sending) {
        toast.info('جارٍ إرسال الصور...');
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
  }, [currentUserId, sending]);

  const openDevicePicker = () => imageInputRef.current?.click();

  const addFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files || []).filter(file => file.type.startsWith('image/'));
    event.currentTarget.value = '';
    if (!files.length) {
      toast.info('اختر صورة بصيغة مدعومة.');
      return;
    }

    const availableSlots = MAX_SELECTED_PHOTOS - selectedIds.length;
    if (files.length > availableSlots) toast.info(`يمكن تحديد ${MAX_SELECTED_PHOTOS} صور كحد أقصى.`);
    const addedPhotos = files.slice(0, Math.max(0, availableSlots)).map((file, index) => {
      const url = URL.createObjectURL(file);
      objectUrlsRef.current.add(url);
      return {
        id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        url,
      };
    });

    if (!addedPhotos.length) return;
    setPhotos(current => [...current, ...addedPhotos]);
    setSelectedIds(current => [...current, ...addedPhotos.map(photo => photo.id)]);
  };

  const togglePhoto = (id: string) => {
    setSelectedIds(current => {
      if (current.includes(id)) return current.filter(selectedId => selectedId !== id);
      if (current.length >= MAX_SELECTED_PHOTOS) {
        toast.info(`يمكن تحديد ${MAX_SELECTED_PHOTOS} صور كحد أقصى.`);
        return current;
      }
      return [...current, id];
    });
  };

  const closePicker = () => {
    setOpen(false);
    setEditingPhotoId(null);
    notifyCaptionChange(caption);
  };

  const replaceEditedPhoto = (id: string, file: File) => {
    const previousPhoto = photos.find(photo => photo.id === id);
    if (previousPhoto) {
      URL.revokeObjectURL(previousPhoto.url);
      objectUrlsRef.current.delete(previousPhoto.url);
    }
    const url = URL.createObjectURL(file);
    objectUrlsRef.current.add(url);
    setPhotos(current => current.map(photo => photo.id === id ? { ...photo, file, url } : photo));
    setEditingPhotoId(null);
  };

  const sendSelectedPhotos = async () => {
    if (sending || selectedPhotos.length === 0) return;
    if (!activeRecipientId || !supabaseConfigured) {
      toast.error('تعذر إرسال الصور لأن المحادثة أو قاعدة البيانات غير جاهزة.');
      return;
    }

    const recipientIdSnapshot = activeRecipientId;
    const selectedPhotosSnapshot = selectedPhotos;
    const photosSnapshot = photos;
    const captionSnapshot = caption.trim();
    const viewOnceSnapshot = viewOnce;
    const hdSnapshot = hd;
    const localUrls: string[] = [];
    try {
      selectedPhotosSnapshot.forEach(photo => {
        const url = URL.createObjectURL(photo.file);
        localUrls.push(url);
        objectUrlsRef.current.add(url);
      });
    } catch (error) {
      localUrls.forEach(url => {
        URL.revokeObjectURL(url);
        objectUrlsRef.current.delete(url);
      });
      console.error('[messages] تعذر تجهيز معاينة الصور المحلية:', error);
      toast.error('تعذر عرض معاينة الصور. حاول اختيارها مرة أخرى.');
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
    const uploadedPaths: string[] = [];
    let messageInserted = false;
    try {
      const uploadResults = await Promise.allSettled(selectedPhotosSnapshot.map(async (photo, index) => {
        const safeName = photo.file.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-80) || 'photo.jpg';
        const path = `${currentUserId}/messages/${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
        await uploadMedia({ file: photo.file, path, quality: hdSnapshot ? 'hd' : 'data-saving' });
        uploadedPaths.push(path);
        return supabase.storage.from(storageBucket).getPublicUrl(path).data.publicUrl;
      }));
      const failedUpload = uploadResults.find(result => result.status === 'rejected');
      if (failedUpload?.status === 'rejected') throw failedUpload.reason;
      const urls = uploadResults.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      const content = `${CHAT_MEDIA_MESSAGE_PREFIX}${JSON.stringify({ urls, caption: captionSnapshot, viewOnce: viewOnceSnapshot })}`;
      if (content.length > 4000) throw new Error('حجم بيانات الصور كبير جداً. قلل عدد الصور وحاول مرة أخرى.');

      const { error } = await supabase.from('messages').insert({
        sender_id: currentUserId,
        recipient_id: recipientIdSnapshot,
        content,
      });
      if (error) throw error;
      messageInserted = true;
      onUploaded?.(pendingMessage.id, recipientIdSnapshot, urls);
      await new Promise(resolve => window.setTimeout(resolve, 200));
      await onSent?.(pendingMessage.id, recipientIdSnapshot);
      releaseLocalUrls();

      photosSnapshot.forEach(photo => {
        URL.revokeObjectURL(photo.url);
        objectUrlsRef.current.delete(photo.url);
      });
      setPhotos([]);
      setSelectedIds([]);
      setCaption('');
      setViewOnce(false);
      notifyCaptionChange('');
      toast.success('تم إرسال الصور');
    } catch (error) {
      if (messageInserted) {
        releaseLocalUrls();
        photosSnapshot.forEach(photo => {
          URL.revokeObjectURL(photo.url);
          objectUrlsRef.current.delete(photo.url);
        });
        setPhotos([]);
        setSelectedIds([]);
        setCaption('');
        setViewOnce(false);
        notifyCaptionChange('');
        onSendFailed?.(pendingMessage.id);
        console.warn('[messages] تعذر تحديث المحادثة بعد إرسال الصور:', error);
        toast.success('تم إرسال الصور');
        return;
      }
      if (uploadedPaths.length) {
        try {
          const { error: cleanupError } = await supabase.storage.from(storageBucket).remove(uploadedPaths);
          if (cleanupError) console.warn('[messages] تعذر تنظيف الصور غير المرسلة:', cleanupError);
        } catch (cleanupError) {
          console.warn('[messages] تعذر تنظيف الصور غير المرسلة:', cleanupError);
        }
      }
      releaseLocalUrls();
      onSendFailed?.(pendingMessage.id);
      notifyCaptionChange(captionSnapshot);
      console.error('[messages] تعذر إرسال الصور:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر إرسال الصور. تحقق من الاتصال وحاول مرة أخرى.');
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <>
      {!editingPhoto ? (
        <section className="chat-media-picker" role="dialog" aria-modal="true" aria-label="اختيار الصور" dir="rtl">
          <header className="chat-media-picker-header" dir="ltr">
            <button type="button" className={`chat-media-picker-hd${hd ? ' is-active' : ''}`} aria-pressed={hd} onClick={() => setHd(value => !value)}>
              HD
            </button>
            <div className="chat-media-picker-tabs" role="tablist" aria-label="نوع الوسائط">
              <button type="button" role="tab" aria-selected={activeTab === 'photos'} className={activeTab === 'photos' ? 'is-active' : ''} onClick={() => setActiveTab('photos')}>الصور</button>
              <button type="button" role="tab" aria-selected={activeTab === 'albums'} className={activeTab === 'albums' ? 'is-active' : ''} onClick={() => setActiveTab('albums')}>الألبومات</button>
            </div>
            <button type="button" className="chat-media-picker-close" aria-label="إغلاق الاستوديو" onClick={closePicker}><X size={28} /></button>
          </header>

          {activeTab === 'photos' ? (
            <div className="chat-media-picker-grid" aria-label="الصور المحددة من الجهاز">
              {photos.map((photo, index) => {
                const selectionNumber = selectedIds.indexOf(photo.id);
                return (
                  <button key={photo.id} type="button" className={`chat-media-picker-photo${selectionNumber >= 0 ? ' is-selected' : ''}`} onClick={() => togglePhoto(photo.id)} aria-label={selectionNumber >= 0 ? `إلغاء تحديد الصورة ${index + 1}` : `تحديد الصورة ${index + 1}`} aria-pressed={selectionNumber >= 0}>
                    <img src={photo.url} alt={photo.file.name || 'صورة من الجهاز'} />
                    <span className="chat-media-picker-number">{selectionNumber >= 0 ? selectionNumber + 1 : ''}</span>
                  </button>
                );
              })}
              <button type="button" className="chat-media-picker-add" onClick={openDevicePicker}>
                <Images size={30} />
                <span>{photos.length ? 'إضافة صور من الجهاز' : 'اختيار صور من الجهاز'}</span>
              </button>
              {photos.length === 0 && (
                <div className="chat-media-picker-empty">
                  <Images size={36} />
                  <span>اختر صوراً من مكتبة جهازك لعرضها هنا</span>
                  <button type="button" onClick={openDevicePicker}>فتح معرض الصور</button>
                </div>
              )}
            </div>
          ) : (
            <div className="chat-media-picker-albums">
              <button type="button" className="chat-media-picker-album" onClick={() => setActiveTab('photos')}>
                <span className="chat-media-picker-album-cover">
                  {photos.slice(0, 4).map(photo => <img key={photo.id} src={photo.url} alt="" />)}
                  {photos.length === 0 && <Images size={30} />}
                </span>
                <span><strong>الأخيرة</strong><small>{photos.length} صور</small></span>
                <Album size={20} />
              </button>
              <button type="button" className="chat-media-picker-add-album" onClick={openDevicePicker}><Images size={20} /> إضافة صور من الجهاز</button>
            </div>
          )}

          <input ref={imageInputRef} type="file" accept="image/*" multiple className="chat-media-picker-input" onChange={addFiles} />

          {selectedPhotos.length > 0 && (
            <div className="chat-media-picker-selection" dir="rtl">
              <button type="button" className="chat-media-picker-send" aria-label={`إرسال ${selectedPhotos.length} صور`} onClick={() => void sendSelectedPhotos()} disabled={sending}>
                {sending ? <LoaderCircle size={22} className="chat-media-picker-loading" /> : <Send size={22} fill="currentColor" />}
                <span className="chat-media-picker-send-count">{selectedPhotos.length}</span>
              </button>
              <input
                className="chat-media-picker-caption"
                type="text"
                value={caption}
                onChange={event => setCaption(event.target.value)}
                maxLength={1000}
                placeholder="إضافة شرح توضيحي..."
                aria-label="إضافة شرح توضيحي للصور"
                dir="rtl"
                disabled={sending}
              />
              <button type="button" className={`chat-media-picker-once${viewOnce ? ' is-active' : ''}`} aria-label="عرض الصورة مرة واحدة" aria-pressed={viewOnce} onClick={() => setViewOnce(value => !value)} disabled={sending}>
                <Eye size={20} />
                <span>1</span>
              </button>
              <button type="button" className="chat-media-picker-edit" aria-label="تعديل الصورة المحددة" onClick={() => setEditingPhotoId(selectedPhotos[0].id)} disabled={sending}>
                <Pencil size={19} />
              </button>
            </div>
          )}
        </section>
      ) : (
        <ChatPhotoEditor
          file={editingPhoto.file}
          quality={hd ? 0.96 : 0.76}
          onCancel={() => setEditingPhotoId(null)}
          onSave={file => replaceEditedPhoto(editingPhoto.id, file)}
        />
      )}
    </>,
    document.body,
  );
}

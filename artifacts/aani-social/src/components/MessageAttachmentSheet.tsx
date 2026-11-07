import { useEffect, useRef, useState, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { FileText, LoaderCircle, MapPin, Send, X } from 'lucide-react';
import { toast } from 'sonner';

import { storageBucket, supabase, supabaseConfigured, supabaseUrl } from '@/lib/supabase';
import { uploadMedia } from '@/lib/storyUpload';

export const CHAT_DOCUMENT_MESSAGE_PREFIX = '[aani-document:v1]';
export const CHAT_LOCATION_MESSAGE_PREFIX = '[aani-location:v1]';

export interface ChatDocumentPayload {
  url: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface ChatLocationPayload {
  latitude: number;
  longitude: number;
  note: string;
}

export function parseChatDocumentMessage(content: string): ChatDocumentPayload | null {
  if (!content.startsWith(CHAT_DOCUMENT_MESSAGE_PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(content.slice(CHAT_DOCUMENT_MESSAGE_PREFIX.length));
    if (!value || typeof value !== 'object') return null;
    const payload = value as Partial<ChatDocumentPayload>;
    if (typeof payload.url !== 'string' || typeof payload.name !== 'string'
      || typeof payload.mimeType !== 'string' || typeof payload.size !== 'number'
      || !Number.isFinite(payload.size) || payload.size < 0) return null;
    const url = new URL(payload.url);
    const storageUrl = new URL(supabaseUrl);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.origin !== storageUrl.origin
      || !url.pathname.startsWith(`/storage/v1/object/public/${storageBucket}/`)) return null;
    return { url: url.toString(), name: payload.name.slice(0, 255), mimeType: payload.mimeType.slice(0, 255), size: payload.size };
  } catch {
    return null;
  }
}

export function parseChatLocationMessage(content: string): ChatLocationPayload | null {
  if (!content.startsWith(CHAT_LOCATION_MESSAGE_PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(content.slice(CHAT_LOCATION_MESSAGE_PREFIX.length));
    if (!value || typeof value !== 'object') return null;
    const payload = value as Partial<ChatLocationPayload>;
    if (typeof payload.latitude !== 'number' || !Number.isFinite(payload.latitude) || Math.abs(payload.latitude) > 90
      || typeof payload.longitude !== 'number' || !Number.isFinite(payload.longitude) || Math.abs(payload.longitude) > 180
      || typeof payload.note !== 'string') return null;
    return { latitude: payload.latitude, longitude: payload.longitude, note: payload.note.slice(0, 1000) };
  } catch {
    return null;
  }
}

type MessageAttachmentSheetProps = {
  open: boolean;
  currentUserId: string;
  recipientId: string;
  replyToMessageId?: string | null;
  onClose: () => void;
  onSent: () => void | Promise<void>;
};

function createMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

export default function MessageAttachmentSheet({
  open,
  currentUserId,
  recipientId,
  replyToMessageId,
  onClose,
  onSent,
}: MessageAttachmentSheetProps) {
  const documentInputRef = useRef<HTMLInputElement>(null);
  const locationModalRef = useRef<HTMLElement>(null);
  const dragStartYRef = useRef<number | null>(null);
  const [locationOpen, setLocationOpen] = useState(false);
  const [locationStatus, setLocationStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [coordinates, setCoordinates] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locationNote, setLocationNote] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open && !locationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (locationOpen) setLocationOpen(false);
      else onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [locationOpen, onClose, open]);

  useEffect(() => {
    if (!locationOpen || coordinates) return;
    if (!navigator.geolocation) {
      setLocationStatus('error');
      return;
    }
    setLocationStatus('loading');
    navigator.geolocation.getCurrentPosition(position => {
      setCoordinates({ latitude: position.coords.latitude, longitude: position.coords.longitude });
      setLocationStatus('ready');
    }, () => setLocationStatus('error'), { enableHighAccuracy: true, timeout: 20_000, maximumAge: 60_000 });
  }, [coordinates, locationOpen]);

  useEffect(() => {
    if (!locationOpen) return;
    const viewport = window.visualViewport;
    const syncViewport = () => {
      const modal = locationModalRef.current;
      if (!modal) return;
      modal.style.top = `${Math.round(viewport?.offsetTop ?? 0)}px`;
      modal.style.bottom = 'auto';
      modal.style.height = `${Math.round(viewport?.height ?? window.innerHeight)}px`;
    };
    syncViewport();
    viewport?.addEventListener('resize', syncViewport);
    viewport?.addEventListener('scroll', syncViewport);
    window.addEventListener('resize', syncViewport);
    return () => {
      viewport?.removeEventListener('resize', syncViewport);
      viewport?.removeEventListener('scroll', syncViewport);
      window.removeEventListener('resize', syncViewport);
      if (locationModalRef.current) {
        locationModalRef.current.style.removeProperty('top');
        locationModalRef.current.style.removeProperty('bottom');
        locationModalRef.current.style.removeProperty('height');
      }
    };
  }, [locationOpen]);

  const sendDocument = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (!supabaseConfigured) {
      toast.error('قاعدة البيانات غير مهيأة.');
      return;
    }

    setSending(true);
    onClose();
    const messageId = createMessageId();
    const safeName = file.name.replace(/[\\/\u0000-\u001f]/g, '_').slice(-180) || 'document';
    const path = `${currentUserId}/messages/${messageId}-${safeName}`;
    try {
      await uploadMedia({ file, path });
      const url = supabase.storage.from(storageBucket).getPublicUrl(path).data.publicUrl;
      const content = `${CHAT_DOCUMENT_MESSAGE_PREFIX}${JSON.stringify({ url, name: file.name.slice(0, 255), mimeType: file.type || 'application/octet-stream', size: file.size })}`;
      if (content.length > 4000) throw new Error('اسم الملف كبير جداً لإرساله.');
      const { error } = await supabase.from('messages').insert({
        id: messageId,
        sender_id: currentUserId,
        recipient_id: recipientId,
        content,
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
      });
      if (error) throw error;
      await onSent();
      toast.success('تم إرسال المستند');
    } catch (error) {
      console.error('[messages] تعذر إرسال المستند:', error);
      toast.error(error instanceof Error ? error.message : 'تعذر إرسال المستند. تحقق من الاتصال وحاول مرة أخرى.');
    } finally {
      setSending(false);
    }
  };

  const sendLocation = async () => {
    if (!coordinates || sending || !supabaseConfigured) {
      if (!supabaseConfigured) toast.error('قاعدة البيانات غير مهيأة.');
      return;
    }
    setSending(true);
    const content = `${CHAT_LOCATION_MESSAGE_PREFIX}${JSON.stringify({
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      note: locationNote.trim().slice(0, 1000),
    })}`;
    try {
      const { error } = await supabase.from('messages').insert({
        sender_id: currentUserId,
        recipient_id: recipientId,
        content,
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
      });
      if (error) throw error;
      setLocationOpen(false);
      setLocationNote('');
      onClose();
      await onSent();
      toast.success('تم إرسال الموقع');
    } catch (error) {
      console.error('[messages] تعذر إرسال الموقع:', error);
      toast.error('تعذر إرسال الموقع. تحقق من الاتصال وحاول مرة أخرى.');
    } finally {
      setSending(false);
    }
  };

  const mapUrl = coordinates ? (() => {
    const { latitude, longitude } = coordinates;
    const bbox = [longitude - 0.012, latitude - 0.008, longitude + 0.012, latitude + 0.008].join(',');
    return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(`${latitude},${longitude}`)}`;
  })() : '';
  const mapLink = coordinates
    ? `https://www.openstreetmap.org/?mlat=${coordinates.latitude}&mlon=${coordinates.longitude}#map=16/${coordinates.latitude}/${coordinates.longitude}`
    : '';

  return createPortal(
    <>
      <input
        ref={documentInputRef}
        className="aani-attachment-file-input"
        type="file"
        accept=".pdf,.doc,.docx,.txt,.rtf,.odt,.xls,.xlsx,.ppt,.pptx,.csv,.zip,.pages,.numbers,.key,text/*,application/*"
        onChange={event => { void sendDocument(event); }}
        aria-label="اختيار مستند لإرساله"
      />
      <div
        className={`aani-attachment-backdrop${open && !locationOpen ? ' is-open' : ''}`}
        aria-hidden={!open || locationOpen}
        onClick={onClose}
      >
        <section
          className={`aani-attachment-sheet${open && !locationOpen ? ' is-open' : ''}`}
          role="dialog"
          aria-modal={open && !locationOpen}
          aria-label="المرفقات"
          dir="rtl"
          onClick={event => event.stopPropagation()}
        >
          <div
            className="aani-attachment-handle-area"
            onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
              dragStartYRef.current = event.clientY;
              try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer capture is optional */ }
            }}
            onPointerUp={(event: ReactPointerEvent<HTMLDivElement>) => {
              const start = dragStartYRef.current;
              dragStartYRef.current = null;
              if (start !== null && event.clientY - start > 60) onClose();
            }}
            onPointerCancel={() => { dragStartYRef.current = null; }}
          >
            <span className="aani-attachment-handle" aria-hidden="true" />
          </div>
          <button type="button" className="aani-attachment-close" aria-label="إغلاق المرفقات" onClick={onClose}>
            <X size={16} />
          </button>
          <div className="aani-attachment-options">
            <button type="button" className="aani-attachment-option" onClick={() => {
              setLocationOpen(true);
              setCoordinates(null);
              setLocationNote('');
            }}>
              <span className="aani-attachment-option-icon"><MapPin size={24} strokeWidth={1.8} /></span>
              <span>الموقع</span>
            </button>
            <button type="button" className="aani-attachment-option" disabled={sending} onClick={() => documentInputRef.current?.click()}>
              <span className="aani-attachment-option-icon"><FileText size={24} strokeWidth={1.8} /></span>
              <span>مستند</span>
            </button>
          </div>
        </section>
      </div>

      {locationOpen && (
        <section ref={locationModalRef} className="aani-location-modal" role="dialog" aria-modal="true" aria-label="إرسال الموقع" dir="rtl">
          <header className="aani-location-header">
            <button type="button" aria-label="العودة إلى المرفقات" onClick={() => setLocationOpen(false)}><X size={21} /></button>
            <h2>إرسال الموقع</h2>
            <span aria-hidden="true" />
          </header>
          <div className="aani-location-map">
            {coordinates ? (
              <iframe title="خريطة موقعك الحالي" src={mapUrl} loading="lazy" referrerPolicy="no-referrer" />
            ) : (
              <div className="aani-location-map-status" role="status">
                {locationStatus === 'loading' ? <><LoaderCircle className="is-spinning" size={27} /><span>جارٍ تحديد موقعك الحالي…</span></> : <><MapPin size={27} /><span>تعذر تحديد موقعك. تحقق من إذن الموقع ثم اضغط إعادة المحاولة.</span></>}
              </div>
            )}
          </div>
          <div className="aani-location-controls">
            {locationStatus === 'error' && !coordinates && (
              <button type="button" className="aani-location-retry" onClick={() => {
                setCoordinates(null);
                if (!navigator.geolocation) {
                  setLocationStatus('error');
                  return;
                }
                setLocationStatus('loading');
                navigator.geolocation.getCurrentPosition(position => {
                  setCoordinates({ latitude: position.coords.latitude, longitude: position.coords.longitude });
                  setLocationStatus('ready');
                }, () => setLocationStatus('error'), { enableHighAccuracy: true, timeout: 20_000, maximumAge: 60_000 });
              }}>إعادة المحاولة</button>
            )}
            <label htmlFor="aani-location-note">توضيح / ملاحظة (اختياري)</label>
            <textarea id="aani-location-note" value={locationNote} maxLength={1000} onChange={event => setLocationNote(event.target.value)} placeholder="أضف ملاحظة للموقع…" rows={2} />
            {coordinates && (
              <a className="aani-location-map-link" href={mapLink} target="_blank" rel="noreferrer">عرض الخريطة عبر OpenStreetMap</a>
            )}
            <button type="button" className="aani-location-send" onClick={() => { void sendLocation(); }} disabled={!coordinates || sending}>
              {sending ? <LoaderCircle className="is-spinning" size={20} /> : <Send size={20} />}
              <span>إرسال الموقع</span>
            </button>
          </div>
        </section>
      )}
    </>,
    document.body,
  );
}

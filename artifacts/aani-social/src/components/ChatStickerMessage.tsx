import { TwemojiEmoji } from '@/components/TwemojiText';

export const CHAT_STICKER_MESSAGE_PREFIX = '[aani-sticker:v1]';

export type ChatStickerPayload =
  | { emoji: string; label: string }
  | { url: string; label: string };

export function parseChatStickerMessage(content: string): ChatStickerPayload | null {
  if (!content.startsWith(CHAT_STICKER_MESSAGE_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(content.slice(CHAT_STICKER_MESSAGE_PREFIX.length));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    const label = typeof value.label === 'string' ? value.label.slice(0, 120) : 'ملصق';
    if (typeof value.emoji === 'string' && value.emoji.length > 0 && value.emoji.length <= 32) {
      return { emoji: value.emoji, label };
    }
    if (typeof value.url === 'string' && value.url.length <= 2048) {
      const url = new URL(value.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') return { url: url.toString(), label };
    }
    return null;
  } catch {
    return null;
  }
}

export default function ChatStickerMessage({ payload }: { payload: ChatStickerPayload }) {
  return (
    <div className="messages-sticker-message" role="img" aria-label={payload.label}>
      {'emoji' in payload
        ? <TwemojiEmoji emoji={payload.emoji} size={116} className="messages-sticker-message-emoji" />
        : <img src={payload.url} alt="" loading="lazy" draggable={false} />}
    </div>
  );
}

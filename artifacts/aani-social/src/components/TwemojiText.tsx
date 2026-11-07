import { useState, type CSSProperties } from 'react';

type EmojiCatalogRecord = {
  name: string;
  unified: string;
  category: string;
  sort_order?: number;
  obsoleted_by?: string;
  skin_variations?: Record<string, { unified: string }>;
};

export type EmojiChoice = {
  emoji: string;
  name: string;
  category: string;
  sortOrder: number;
};

export const EMOJI_CATEGORY_LABELS: Record<string, string> = {
  'Smileys & Emotion': 'الوجوه والمشاعر',
  'People & Body': 'الأشخاص والجسم',
  'Animals & Nature': 'الحيوانات والطبيعة',
  'Food & Drink': 'الطعام والشراب',
  'Travel & Places': 'السفر والأماكن',
  Activities: 'الأنشطة',
  Objects: 'الأشياء',
  Symbols: 'الرموز',
  Flags: 'الأعلام',
};

export function emojiFromUnified(unified: string): string {
  return unified.split('-').map(codePoint => String.fromCodePoint(Number.parseInt(codePoint, 16))).join('');
}

export function normalizeEmojiCatalog(value: unknown): EmojiChoice[] {
  if (!Array.isArray(value)) return [];
  const choices: EmojiChoice[] = [];
  (value as EmojiCatalogRecord[]).forEach(entry => {
    if (!entry || typeof entry.unified !== 'string' || !EMOJI_CATEGORY_LABELS[entry.category] || entry.obsoleted_by) return;
    choices.push({
      emoji: emojiFromUnified(entry.unified),
      name: entry.name,
      category: entry.category,
      sortOrder: entry.sort_order ?? Number.MAX_SAFE_INTEGER,
    });
    Object.values(entry.skin_variations || {}).forEach(variation => {
      if (typeof variation.unified !== 'string') return;
      choices.push({
        emoji: emojiFromUnified(variation.unified),
        name: entry.name,
        category: entry.category,
        sortOrder: entry.sort_order ?? Number.MAX_SAFE_INTEGER,
      });
    });
  });
  return choices.sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
}

export function emojiImageUrl(emoji: string): string {
  const codePoints = Array.from(emoji, character => character.codePointAt(0))
    .filter((codePoint): codePoint is number => codePoint !== undefined && codePoint !== 0xfe0e && codePoint !== 0xfe0f)
    .map(codePoint => codePoint.toString(16));
  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@17.0.3/assets/svg/${codePoints.join('-')}.svg`;
}

const SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;
const EMOJI_GRAPHEME = /(?:\p{Emoji_Presentation}|\p{Regional_Indicator}|\uFE0F|\u20E3)/u;

export function TwemojiEmoji({
  emoji,
  size,
  className = '',
}: {
  emoji: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const style: CSSProperties | undefined = size ? { width: size, height: size } : undefined;
  if (failed) return <span className={`twemoji-fallback ${className}`}>{emoji}</span>;
  return (
    <img
      className={`twemoji-image${className ? ` ${className}` : ''}`}
      src={emojiImageUrl(emoji)}
      alt={emoji}
      draggable={false}
      loading="lazy"
      style={style}
      onError={() => setFailed(true)}
    />
  );
}

export default function EmojiText({ text, className = '' }: { text: string; className?: string }) {
  if (!SEGMENTER) return <span className={`twemoji-text${className ? ` ${className}` : ''}`}>{text}</span>;
  const segments = Array.from(SEGMENTER.segment(text), part => part.segment);
  return (
    <span className={`twemoji-text${className ? ` ${className}` : ''}`}>
      {segments.map((segment, index) => EMOJI_GRAPHEME.test(segment)
        ? <TwemojiEmoji key={`${index}-${segment}`} emoji={segment} />
        : <span key={`${index}-${segment}`}>{segment}</span>)}
    </span>
  );
}

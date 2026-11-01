// مكتبة ملصقات تعبيرية (SVG) — ردود أفعال وميمز وعبارات نيون مثل ملصقات إنستغرام وتيك توك

export type StickerCategory = 'reactions' | 'memes' | 'neon' | 'moods' | 'love' | 'phrases';

export interface StickerDefinition {
  id: string;
  label: string;
  category: StickerCategory;
  src: string;
}

export interface StickerCategoryInfo {
  key: StickerCategory;
  label: string;
}

export const STICKER_CATEGORIES: StickerCategoryInfo[] = [
  { key: 'reactions', label: 'ردود أفعال' },
  { key: 'memes', label: 'ميمز' },
  { key: 'neon', label: 'نيون' },
  { key: 'moods', label: 'مشاعر' },
  { key: 'love', label: 'حب' },
  { key: 'phrases', label: 'عبارات' },
];

type Variant = 'outline' | 'neon' | 'bubble' | 'retro' | 'glow';

interface Draft {
  text: string;
  variant: Variant;
  accent?: string;
}

const FONT_STACK = "'Cairo','Tajawal','Arial Black',Arial,sans-serif";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildStickerSrc({ text, variant, accent = '#FF2D55' }: Draft): string {
  const value = escapeXml(text);
  const width = Math.max(260, Math.min(620, text.length * 58));
  const height = 190;
  const fontSize = text.length > 8 ? 62 : 82;
  const centerX = width / 2;
  const centerY = height / 2;

  const textAttrs = `x="${centerX}" y="${centerY + fontSize / 3}" text-anchor="middle" font-family="${FONT_STACK}" font-size="${fontSize}" font-weight="900"`;

  let body = '';

  if (variant === 'bubble') {
    body = `
      <rect x="10" y="10" width="${width - 20}" height="${height - 20}" rx="${height / 2 - 10}" fill="${accent}" stroke="#ffffff" stroke-width="10" />
      <text ${textAttrs} fill="#ffffff" letter-spacing="1">${value}</text>
    `;
  } else if (variant === 'neon') {
    body = `
      <text ${textAttrs} fill="#ffffff" stroke="${accent}" stroke-width="14" stroke-linejoin="round" opacity="0.55" filter="url(#soft)">${value}</text>
      <text ${textAttrs} fill="#ffffff" stroke="${accent}" stroke-width="6" stroke-linejoin="round">${value}</text>
      <text ${textAttrs} fill="#ffffff">${value}</text>
    `;
  } else if (variant === 'retro') {
    body = `
      <text ${textAttrs} fill="${accent}" stroke="#111111" stroke-width="16" stroke-linejoin="round">${value}</text>
      <text ${textAttrs} fill="#FFF7E0">${value}</text>
    `;
  } else if (variant === 'glow') {
    body = `
      <text ${textAttrs} fill="${accent}" opacity="0.55" filter="url(#soft)" stroke="${accent}" stroke-width="18" stroke-linejoin="round">${value}</text>
      <text ${textAttrs} fill="#ffffff" stroke="#1a1a1a" stroke-width="10" stroke-linejoin="round">${value}</text>
      <text ${textAttrs} fill="#ffffff">${value}</text>
    `;
  } else {
    body = `
      <text ${textAttrs} fill="#ffffff" stroke="#111111" stroke-width="18" stroke-linejoin="round" stroke-linecap="round">${value}</text>
      <text ${textAttrs} fill="#ffffff">${value}</text>
    `;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <defs>
      <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="7" />
      </filter>
    </defs>
    ${body}
  </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const REACTIONS: Draft[] = [
  { text: 'OMG', variant: 'outline', accent: '#FFD166' },
  { text: 'LOL', variant: 'retro', accent: '#FFB703' },
  { text: 'WOW', variant: 'neon', accent: '#00E5FF' },
  { text: 'BRB', variant: 'bubble', accent: '#FF2D55' },
  { text: 'NO WAY', variant: 'outline', accent: '#F72585' },
  { text: 'WHAT?!', variant: 'retro', accent: '#FEE440' },
  { text: 'SERIOUSLY', variant: 'outline', accent: '#90BE6D' },
  { text: 'SAME', variant: 'bubble', accent: '#7B2CBF' },
];

const MEMES: Draft[] = [
  { text: 'I CAN’T', variant: 'retro', accent: '#FFBE0B' },
  { text: 'I’M DONE', variant: 'outline', accent: '#FB5607' },
  { text: 'MOOD', variant: 'neon', accent: '#8338EC' },
  { text: 'SEND HELP', variant: 'bubble', accent: '#FF006E' },
  { text: 'WHY ME', variant: 'outline', accent: '#3A86FF' },
  { text: 'TOO REAL', variant: 'retro', accent: '#06D6A0' },
  { text: 'NOT TODAY', variant: 'bubble', accent: '#118AB2' },
  { text: 'BIG MOOD', variant: 'neon', accent: '#EF476F' },
];

const NEON: Draft[] = [
  { text: 'LET’S GO', variant: 'neon', accent: '#00F5D4' },
  { text: 'HYPE', variant: 'neon', accent: '#F15BB5' },
  { text: 'GLOW UP', variant: 'glow', accent: '#9B5DE5' },
  { text: 'GOOD VIBES', variant: 'neon', accent: '#00BBF9' },
  { text: 'ON FIRE', variant: 'glow', accent: '#FF3C00' },
  { text: 'SHINE', variant: 'neon', accent: '#FEE440' },
  { text: 'VIBING', variant: 'glow', accent: '#00E5FF' },
  { text: 'MAGIC', variant: 'neon', accent: '#B388FF' },
];

const MOODS: Draft[] = [
  { text: 'TIRED', variant: 'outline', accent: '#8D99AE' },
  { text: 'ANXIOUS', variant: 'bubble', accent: '#5C677D' },
  { text: 'HAPPY', variant: 'retro', accent: '#FFD166' },
  { text: 'SAD', variant: 'outline', accent: '#4EA8DE' },
  { text: 'BLESSED', variant: 'glow', accent: '#FFAFCC' },
  { text: 'OVER IT', variant: 'retro', accent: '#C77DFF' },
  { text: 'CHILL', variant: 'neon', accent: '#48CAE4' },
  { text: 'STRESSED', variant: 'outline', accent: '#FF6B6B' },
];

const LOVE: Draft[] = [
  { text: 'LOVE YOU', variant: 'glow', accent: '#FF2D55' },
  { text: 'CUTIE', variant: 'bubble', accent: '#FF85A1' },
  { text: 'MY PERSON', variant: 'neon', accent: '#FF477E' },
  { text: 'SWEET', variant: 'retro', accent: '#FF9EBB' },
  { text: 'XOXO', variant: 'outline', accent: '#FF006E' },
  { text: 'SIMP', variant: 'bubble', accent: '#F72585' },
  { text: 'CRUSH', variant: 'glow', accent: '#FF5D8F' },
  { text: 'FOREVER', variant: 'neon', accent: '#E5383B' },
];

const PHRASES: Draft[] = [
  { text: 'يا سلااام', variant: 'outline', accent: '#FFD166' },
  { text: 'شكد حلو', variant: 'bubble', accent: '#FF2D55' },
  { text: 'ههههههه', variant: 'retro', accent: '#FEE440' },
  { text: 'أني ميت', variant: 'outline', accent: '#8AC926' },
  { text: 'ماكو فايدة', variant: 'neon', accent: '#00E5FF' },
  { text: 'عيني عليك', variant: 'glow', accent: '#FFAFCC' },
  { text: 'بعد قلبي', variant: 'bubble', accent: '#F72585' },
  { text: 'خوش ولد', variant: 'retro', accent: '#4CC9F0' },
];

function build(items: Draft[], category: StickerCategory): StickerDefinition[] {
  return items.map((item, index) => ({
    id: `${category}-${index}`,
    label: item.text,
    category,
    src: buildStickerSrc(item),
  }));
}

export const STICKERS: StickerDefinition[] = [
  ...build(REACTIONS, 'reactions'),
  ...build(MEMES, 'memes'),
  ...build(NEON, 'neon'),
  ...build(MOODS, 'moods'),
  ...build(LOVE, 'love'),
  ...build(PHRASES, 'phrases'),
];

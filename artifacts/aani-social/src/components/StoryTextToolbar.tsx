import { useState } from 'react';

import {
  STORY_FONTS_AR,
  STORY_FONTS_EN,
  STORY_TEXT_ALIGN_LABELS,
  STORY_TEXT_ANIMATIONS,
  STORY_TEXT_COLORS,
  type StoryFontTab,
  type StoryTextAlign,
  type StoryTextAnimation,
} from '@/lib/storyFonts';

type PanelKey = 'font' | 'color' | 'animation' | null;

export interface StoryTextToolbarProps {
  fontFamily: string;
  onFontFamilyChange: (family: string) => void;
  textColor: string;
  onTextColorChange: (color: string) => void;
  align: StoryTextAlign;
  onCycleAlign: () => void;
  backgroundLabel: string;
  backgroundSwatch: string;
  onCycleBackground: () => void;
  animation: StoryTextAnimation;
  onAnimationChange: (animation: StoryTextAnimation) => void;
}

const ICON_BUTTON_BASE =
  'relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border backdrop-blur-md transition active:scale-95';
const ICON_BUTTON_IDLE = 'border-white/15 bg-white/10 text-white';
const ICON_BUTTON_ACTIVE = 'border-white bg-white text-[#121212]';

const CHIP = 'shrink-0 rounded-xl border px-3 py-1.5 text-[12px] transition active:scale-95';
const ACTIVE_CHIP = 'border-white bg-white font-bold text-[#121212]';
const IDLE_CHIP = 'border-white/15 bg-white/5 text-white/85';

const PANEL =
  'absolute bottom-full left-0 right-0 z-30 mb-2.5 rounded-2xl border border-white/10 bg-[#101014]/95 p-2.5 shadow-2xl backdrop-blur-xl';

const LIGHT_BACKGROUNDS = ['#FFFFFF', '#F6E05E', '#C7C7CC', '#68D391', '#4FD1C5', '#FBD38D'];

function AlignGlyph({ align }: { align: StoryTextAlign }) {
  const widths = align === 'center' ? [16, 11, 16] : align === 'right' ? [16, 16, 11] : [11, 16, 16];
  const itemAlign: 'center' | 'flex-end' | 'flex-start' =
    align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';

  return (
    <span className="flex w-4 flex-col gap-[3px]" style={{ alignItems: itemAlign }}>
      {widths.map((width, index) => (
        <span key={index} className="block h-[2px] rounded-full bg-current" style={{ width: `${width}px` }} />
      ))}
    </span>
  );
}

export default function StoryTextToolbar({
  fontFamily,
  onFontFamilyChange,
  textColor,
  onTextColorChange,
  align,
  onCycleAlign,
  backgroundLabel,
  backgroundSwatch,
  onCycleBackground,
  animation,
  onAnimationChange,
}: StoryTextToolbarProps) {
  const [panel, setPanel] = useState<PanelKey>(null);
  const [fontTab, setFontTab] = useState<StoryFontTab>('ar');

  const fonts = fontTab === 'ar' ? STORY_FONTS_AR : STORY_FONTS_EN;
  const isLightBackground = LIGHT_BACKGROUNDS.includes(backgroundSwatch.toUpperCase());

  const togglePanel = (key: Exclude<PanelKey, null>) => {
    setPanel(current => (current === key ? null : key));
  };

  return (
    <div className="relative w-full" dir="rtl">
      {/* لوحة الخطوط: قائمة تمرير أفقية فوق الشريط */}
      {panel === 'font' && (
        <div className={PANEL}>
          <div className="mb-2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setFontTab('ar')}
              className={`rounded-full px-2.5 py-1 text-[10px] transition ${
                fontTab === 'ar' ? 'bg-white font-bold text-[#121212]' : 'text-white/60'
              }`}
            >
              خطوط عربية
            </button>
            <button
              type="button"
              onClick={() => setFontTab('en')}
              className={`rounded-full px-2.5 py-1 text-[10px] transition ${
                fontTab === 'en' ? 'bg-white font-bold text-[#121212]' : 'text-white/60'
              }`}
            >
              English
            </button>
            <span className="ms-auto text-[10px] text-white/35">{fonts.length} خطاً</span>
          </div>

          <div className="aani-hscroll flex gap-2 overflow-x-auto pb-1">
            {fonts.map(font => (
              <button
                key={font.family}
                type="button"
                onClick={() => onFontFamilyChange(font.family)}
                style={{ fontFamily: font.family }}
                className={`${CHIP} ${fontFamily === font.family ? ACTIVE_CHIP : IDLE_CHIP}`}
              >
                {font.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* لوحة الألوان */}
      {panel === 'color' && (
        <div className={PANEL}>
          <div className="grid grid-cols-8 gap-1.5">
            {STORY_TEXT_COLORS.map(color => (
              <button
                key={color}
                type="button"
                aria-label={`لون ${color}`}
                onClick={() => onTextColorChange(color)}
                className={`h-6 w-6 rounded-full border transition active:scale-90 ${
                  textColor.toLowerCase() === color.toLowerCase()
                    ? 'border-white ring-2 ring-white/50'
                    : 'border-white/25'
                }`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>

          <label className="mt-2.5 flex items-center justify-between gap-2 rounded-xl bg-white/5 px-3 py-2 text-[11px] text-white/80">
            <span className="flex items-center gap-1.5">
              <span
                className="h-3.5 w-3.5 rounded-full border border-white/50"
                aria-hidden="true"
                style={{
                  background:
                    'conic-gradient(#FF3B30, #FFCC00, #34C759, #00C7BE, #007AFF, #AF52DE, #FF3B30)',
                }}
              />
              لون مخصص / قطارة
            </span>
            <input
              type="color"
              value={textColor}
              onChange={event => onTextColorChange(event.target.value)}
              aria-label="اختيار لون مخصص"
              className="h-7 w-10 cursor-pointer rounded-lg border border-white/20 bg-transparent p-0"
            />
          </label>
        </div>
      )}

      {/* لوحة حركات النص */}
      {panel === 'animation' && (
        <div className={PANEL}>
          <div className="aani-hscroll flex gap-2 overflow-x-auto pb-1">
            {STORY_TEXT_ANIMATIONS.map(item => (
              <button
                key={item.key}
                type="button"
                onClick={() => onAnimationChange(item.key)}
                className={`${CHIP} ${animation === item.key ? ACTIVE_CHIP : IDLE_CHIP}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* الشريط: من اليسار إلى اليمين — Aa، الألوان، الحركات، المحاذاة، الخلفية، مكان الأيقونة القادمة */}
      <div
        className="flex items-center justify-center gap-2 overflow-x-auto rounded-full border border-white/10 bg-black/55 px-2 py-1.5 shadow-2xl backdrop-blur-xl aani-hscroll"
        dir="ltr"
      >
        <button
          type="button"
          onClick={() => togglePanel('font')}
          aria-label="تعديل الخط"
          aria-pressed={panel === 'font'}
          className={`${ICON_BUTTON_BASE} ${panel === 'font' ? ICON_BUTTON_ACTIVE : ICON_BUTTON_IDLE}`}
        >
          <span className="text-[15px] font-bold leading-none">Aa</span>
        </button>

        <button
          type="button"
          onClick={() => togglePanel('color')}
          aria-label="ألوان النص"
          aria-pressed={panel === 'color'}
          className={`${ICON_BUTTON_BASE} ${ICON_BUTTON_IDLE}`}
        >
          <span
            className="absolute inset-1 rounded-full"
            style={{
              background:
                'conic-gradient(from 210deg, #FF3B30, #FFCC00, #34C759, #00C7BE, #007AFF, #AF52DE, #FF2D55, #FF3B30)',
            }}
          />
          <span
            className="relative h-4 w-4 rounded-full ring-2 ring-black/60"
            style={{ backgroundColor: textColor }}
          />
        </button>

        <button
          type="button"
          onClick={() => togglePanel('animation')}
          aria-label="حركات النص"
          aria-pressed={panel === 'animation'}
          className={`${ICON_BUTTON_BASE} ${panel === 'animation' ? ICON_BUTTON_ACTIVE : ICON_BUTTON_IDLE}`}
        >
          <span className="text-[10px] font-black leading-none tracking-tighter" dir="ltr">
            ///A
          </span>
        </button>

        <button
          type="button"
          onClick={onCycleAlign}
          aria-label={STORY_TEXT_ALIGN_LABELS[align]}
          className={`${ICON_BUTTON_BASE} ${ICON_BUTTON_IDLE}`}
        >
          <AlignGlyph align={align} />
        </button>

        <button
          type="button"
          onClick={onCycleBackground}
          aria-label={`خلفية النص: ${backgroundLabel}`}
          className={`${ICON_BUTTON_BASE} ${ICON_BUTTON_IDLE}`}
        >
          <span
            className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border border-white/70 text-[10px] font-bold"
            style={{
              background: backgroundSwatch === 'transparent' ? 'transparent' : backgroundSwatch,
              color: isLightBackground ? '#121212' : '#FFFFFF',
            }}
          >
            A
          </span>
        </button>

        {/* مكان محجوز للأيقونة القادمة */}
        <button
          type="button"
          disabled
          aria-label="أيقونة قادمة"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-white/20 text-[16px] leading-none text-white/25"
        >
          +
        </button>
      </div>
    </div>
  );
}

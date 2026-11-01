// طبقة تجريد مزوّدي الموسيقى — تسمح بإضافة مزوّد حقيقي لاحقاً دون تغيير الواجهة.
// أي مزوّد يجب أن يلتزم بترخيص يسمح الاستخدام داخل الستوري.

export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  /** رابط معاينة صوتية قصيرة (mp3/m4a) */
  previewUrl: string;
  artworkUrl?: string;
  /** معرّف المزوّد الذي جاء منه المقطع */
  providerId: string;
  /** ملاحظة الترخيص/الإسناد المطلوب عند النشر */
  license?: string;
}

export interface MusicProvider {
  id: string;
  name: string;
  /** هل يفرض المزوّد ذكر المصدر داخل القصة؟ */
  requiresAttribution: boolean;
  search(query: string): Promise<MusicTrack[]>;
  trending(): Promise<MusicTrack[]>;
}

const providers = new Map<string, MusicProvider>();

/** تسجيل مزوّد جديد (يُستدعى مرة واحدة عند تحميل التطبيق) */
export function registerMusicProvider(provider: MusicProvider): void {
  providers.set(provider.id, provider);
}

export function listMusicProviders(): MusicProvider[] {
  return Array.from(providers.values());
}

/** المزوّد النشط حسب الإعداد المركزي */
export function getMusicProvider(id: string = ACTIVE_MUSIC_PROVIDER_ID): MusicProvider | null {
  if (!id) return null;
  return providers.get(id) ?? null;
}

/**
 * الإعداد المركزي لتفعيل الموسيقى:
 *   VITE_MUSIC_FEATURE_ENABLED=true   → يفتح واجهة اختيار الموسيقى الحقيقية
 *   غير ذلك                            → تظهر نافذة «قادمة قريباً»
 */
export const MUSIC_FEATURE_ENABLED = (import.meta.env.VITE_MUSIC_FEATURE_ENABLED ?? 'false') === 'true';

/** مزوّد الموسيقى المطلوب تفعيله (فارغ = لا مزوّد بعد) */
export const ACTIVE_MUSIC_PROVIDER_ID = (import.meta.env.VITE_MUSIC_PROVIDER_ID as string | undefined) ?? '';

# الموسيقى في الستوري — دليل التشغيل

البنية الحالية تجعل واجهة المستخدم ونشر القصص مستقلَّين تماماً عن مزوّد الموسيقى.
الآن الميزة معطّلة ويظهر للعميل نافذة «ميزة الموسيقى قادمة قريباً».

## 1) الإعداد المركزي

في متغيّرات البيئة (`.env` أو إعدادات المنصة):

```
VITE_MUSIC_FEATURE_ENABLED=false   # false = رسالة «قادمة قريباً»، true = واجهة الاختيار الحقيقية
VITE_MUSIC_PROVIDER_ID=            # معرّف المزوّد المسجّل (freesound / jamendo / ...)
```

## 2) إضافة مزوّد حقيقي

المزوّد يلتزم بواجهة `MusicProvider` في `src/lib/music/index.ts`:

```ts
import { registerMusicProvider, type MusicTrack } from '@/lib/music';

registerMusicProvider({
  id: 'my-provider',
  name: 'My Provider',
  requiresAttribution: true,
  async search(query: string): Promise<MusicTrack[]> {
    // طلب إلى API المزوّد ثم تحويل النتيجة إلى MusicTrack[]
    return [];
  },
  async trending(): Promise<MusicTrack[]> {
    return [];
  },
});
```

ثم اضبط `VITE_MUSIC_PROVIDER_ID` على نفس `id` وفعّل `VITE_MUSIC_FEATURE_ENABLED=true`.
تُستدعى `registerMusicProvider` مرة واحدة عند تحميل التطبيق (مثلاً من `main.tsx`).

## 3) الترخيص

قبل تشغيل أي مزوّد في الإنتاج، تحقق من شروط الترخيص للاستخدام داخل القصص:
- Freesound: تراخيص CC تختلف حسب المقطع، تتطلب إسناداً في معظم الحالات.
- Jamendo: تراخيص CC، تتطلب إسناداً للفنان.
- Spotify / Apple Music / Anghami: لا تسمح بالاستخدام التجاري داخل تطبيق طرف ثالث عبر واجهاتها العامة.

الحقل `license` في `MusicTrack` مخصّص لعرض الإسناد المطلوب عند النشر.

## 4) الحالة الحالية

- زر الموسيقى في شريط أدوات الستوري لم يتغيّر في مكانه أو شكله.
- عند التعطيل: نافذة صغيرة قابلة للإغلاق تعرض «ميزة الموسيقى قادمة قريباً».
- عند التفعيل مع مزوّد مسجّل: تُفتح واجهة بحث واختيار الأغاني داخل نفس النافذة.

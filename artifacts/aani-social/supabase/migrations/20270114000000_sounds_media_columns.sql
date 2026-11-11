-- أعمدة ميديا نظام الأصوات (Aani Media Engine — Clean Slate Migration):
-- كل الأعمدة اختيارية (nullable) ومتوافقة تماماً مع الاستخدام الحالي لجدول
-- public.sounds — لا يُكسر أي استعلام أو ميزة قائمة قبل تفعيلها في الواجهة.
--   duration        : المدة الكاملة بالثواني (تُحسب عند إنشاء الصوت)
--   preview_url     : رابط مقطع معاينة صوتي مستخرج (يُفكَّك في RAM للمعاينة <10ms)
--   peaks           : قمم الموجة الصوتية (مصفوفة 256 نقطة normalized 0..1)
--   trim_start_sec  : زمن الاقتصاص الافتراضي بدايةً (بالثواني)
--   trim_end_sec    : زمن الاقتصاص الافتراضي نهايةً (بالثواني)
--   original_vol    : مستوى الصوت الأصلي في مزج Dual Audio (0..1)
--   music_vol       : مستوى الموسيقى المختارة في مزج Dual Audio (0..1)
--   source_post_id  : المنشور المصدر الذي وُلّد الصوت من (خيار "استخدام هذا الصوت")
--   category        : تصنيف الصوت — 'trending' = مقترح تلقائياً، 'mine' = مستخرج من فيديوهات المستخدم
begin;

alter table public.sounds
  add column if not exists duration real,
  add column if not exists preview_url text,
  add column if not exists peaks jsonb,
  add column if not exists trim_start_sec real,
  add column if not exists trim_end_sec real,
  add column if not exists original_vol real default 1,
  add column if not exists music_vol real default 1,
  add column if not exists source_post_id uuid references public.posts (id) on delete set null,
  add column if not exists category text not null default 'trending';

create index if not exists sounds_category_idx
  on public.sounds (category, created_at desc);

create index if not exists sounds_source_post_idx
  on public.sounds (source_post_id);

-- منح قراءة الأعمدة الجديدة (منح تراكمي لا يمس أي منح سابق)
grant select (duration, preview_url, peaks, trim_start_sec, trim_end_sec, original_vol, music_vol, source_post_id, category)
  on public.sounds to authenticated;

commit;

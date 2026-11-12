-- عمود الصوت المعزول الخفيف (AAC .m4a) لمكتبة الأصوات.
-- عند نشر فيديو يُستخرج الصوت محلياً في الهاتف (mediabunny/WebCodecs)، يُرفع
-- إلى ImageKit كملف .m4a صغير، ويُخزَّن رابطه في sounds.preview_url — فتستهلك
-- المعاينات (SoundPickerSheet) والمشغلات صوتاً خفيفاً بدل الفيديو الكامل.
alter table public.sounds add column if not exists preview_url text;

-- توسيع الصلاحيات على مستوى الجدول لتشمل العمود الجديد (تضاف ولا تُستبدل)
grant select, insert, update on table public.sounds to authenticated;

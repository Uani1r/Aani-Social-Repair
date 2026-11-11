-- أوقات اقتصاص الصوت في نظام الأصوات (TikTok):
-- عمودان على posts يخزنان زمني بداية/نهاية الصوت المختار من مكتبة
-- الأصوات (بالثواني)، فيسمع الجميع نفس الجزء المقتص بعد النشر.
-- منفصلان عن trim_start/trim_end الخاصين بقص الفيديو نفسه.
begin;

alter table public.posts
  add column if not exists sound_trim_start real,
  add column if not exists sound_trim_end real;

-- منح قراءة العمودين (منح تراكمي لا يمس أي منح سابق)
grant select (sound_trim_start, sound_trim_end) on table public.posts to authenticated;

commit;

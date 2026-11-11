-- ترحيل: السماح بنشر الصور إلى الريلز (مع الصوت)
-- يُطبق يدوياً في Supabase SQL Editor. آمن للتكرار (idempotent).

-- القيد القديم كان يشترط type = 'reel' عند destination = 'reels'.
-- يُحدَّث هنا للسماح بمنشورات الصور (type = 'photo') في قسم الريلز.
alter table public.posts drop constraint if exists posts_destination_check;
alter table public.posts
  add constraint posts_destination_check
  check (
    destination in ('feed', 'reels')
    and (destination <> 'reels' or type in ('reel', 'photo'))
  );

-- أعمدة الصوت (audio_url, audio_title) موجودة من ترحيل post_controls السابق
-- ولا حاجة لأي إضافة هنا.

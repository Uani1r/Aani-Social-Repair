-- فلاتر الستوري: يخزّن معرّف الفلتر + التعديلات المطبّقة على الوسيط
-- الصيغة: "{filterId}|{brightness}|{contrast}|{saturation}|{warmth}|{clarity}"

alter table public.stories
  add column if not exists filter_key text;

comment on column public.stories.filter_key is
  'معرّف فلتر الستوري مع تعديلات الصورة، يُطبّق عند العرض ولا يغيّر الملف الأصلي';

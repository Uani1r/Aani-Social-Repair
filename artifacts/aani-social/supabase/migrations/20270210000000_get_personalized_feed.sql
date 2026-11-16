-- =====================================================================
-- المرحلة الرابعة — 4-A: دالة الترتيب الشخصي للتغذية
-- public.get_personalized_feed(p_limit, p_candidate_limit)
--
-- حالة هذا الملف: **مقترح للمراجعة — لم يُنفَّذ على Supabase ولا على
-- Production**. لم يُطبَّق أي SQL، ولم يُلمس أي جدول أو سياسة أو صلاحية.
--
-- ما تفعله الدالة: تُعيد ترتيباً فقط — لا تُعيد صفوف المنشورات ولا حقول
-- الوسائط ولا روابط ImageKit. جلب الصفوف وتجهيز الوسائط يبقيان في مسار
-- التطبيق الحالي (usePosts.ts) في الجزء 4-B.
--
-- الأعمدة المُعادة (أربعة فقط):
--   post_id uuid, reposter_id uuid null, reposted_at timestamptz null,
--   rank_position integer
-- وهي نفس الأسماء التي يقرأها usePosts.ts حالياً لصفوف إعادة النشر
-- (usePosts.ts سطر 249-250: reposter_id و reposted_at)، فالتوافق مع 4-B
-- لا يحتاج تغيير اسم.
--
-- قراءة فقط: لا INSERT ولا UPDATE ولا DELETE، ولا كتابة في أي جدول.
-- لا تُعدّل الدالة ترتيب المنشورات ولا بياناتها في قاعدة البيانات.
--
-- ---------------------------------------------------------------------
-- الأمان (بند 7 من المهمة)
-- ---------------------------------------------------------------------
--   * security invoker — لا security definer في أي مسار. RLS على كل جدول
--     يقرأه الجسم يُطبَّق بصلاحيات المستخدم المستدعي نفسه.
--   * set search_path = '' مع تأهيل كامل: public.* للجداول و auth.uid().
--   * الهوية من auth.uid() فقط. لا تُقبل user_id من الواجهة ولا من المدخلات.
--     إن كانت الهوية NULL تُعيد الدالة صفر صفوف فوراً.
--   * revoke all من public و anon، و grant execute إلى authenticated فقط.
--     (PostgreSQL يمنح EXECUTE إلى PUBLIC افتراضياً لكل دالة جديدة، فالسحب
--     من PUBLIC ليس تجميلياً.)
--   * لا تُمنح أي صلاحية إضافية على أي جدول، ولا تُنشأ أو تُعدَّل سياسة.
--
-- ---------------------------------------------------------------------
-- الخصوصية والحظر (بند 3)
-- ---------------------------------------------------------------------
--   * لا تُعيد الدالة منشوراً لا يملك المستخدم حق قراءته، لأن كل قراءة تمرّ
--     عبر سياسة القراءة الحالية على public.posts:
--       - "Signed-in users can read posts"  (permissive, aani_can_read_post)
--       - aani_posts_private_read_guard     (restrictive, نفس القاعدة)
--       - aani_posts_block_guard            (restrictive, الحظر في الاتجاهين)
--     أي أن الخصوصية (is_private + visibility) والحظر يُطبَّقان تلقائياً بلا
--     إعادة كتابة قواعدهما هنا، وبلا تجاوزها.
--   * الإشارات الشخصية (impressions/views/feedback) تُقرأ بـ user_id =
--     auth.uid() فقط، فلا تُحتسب سجلات مستخدمين آخرين اهتماماً شخصياً.
--
-- ---------------------------------------------------------------------
-- ⚠ قيد حقيقي في المخطط الحالي يجب أن يُراجع قبل الاعتماد على المصدر (3)
-- ---------------------------------------------------------------------
--   جدول public.reposts يحمل سياسة قراءة متساهلة واحدة فقط:
--       aani_reposts_select_own  for select using (auth.uid() = user_id)
--   (schema.sql سطر 719-722، و20261026000000 سطر 111-114 — لا يوجد أي ترحيل
--   لاحق يستبدلها بسياسة أوسع؛ 20270205000000 يضيف حارساً restrictive فقط.)
--
--   لذلك، ومع security invoker، لا يمكن للدالة أن تقرأ إعادات نشر
--   **المستخدمين الآخرين**. المصدر (3) يعمل اليوم على إعادات نشر المستخدم
--   نفسه فقط، ويتوسّع تلقائياً لو مُنحت قراءة أوسع لاحقاً.
--
--   لم أوسّع الصلاحية تلقائياً: هذا ممنوع في المهمة. للمراجعة خيارَان:
--     (أ) الإبقاء على السلوك الحالي (إعادات المستخدم نفسه) — لا تغيير أمني.
--     (ب) ترحيل منفصل يضيف سياسة قراءة متساهلة على reposts بشرط
--         public.aani_can_read_post(post_id, auth.uid())
--         — أي: يُقرأ سجل إعادة النشر فقط لمنشور يملك المشاهد حق قراءته.
--         يحتاج قراراً منفصلاً لأنه يوسّع قراءة جدول قائم.
--
-- ---------------------------------------------------------------------
-- الإشارات قليلة البيانات (بند 4)
-- ---------------------------------------------------------------------
--   post_impressions و post_view_events و post_feedback قد تكون فارغة.
--   كلها تدخل بـ LEFT JOIN على تجميع مسبق بمفتاح post_id، وكل قيمة عددية
--   تُغلَّف بـ COALESCE(..., 0). لا يوجد INNER JOIN مع أي جدول إشارات، فغياب
--   السجلات لا يستبعد منشوراً ولا يُفرغ النتيجة ولا يُعطّل الترتيب.
--
--   النوافذ الزمنية (ثابتة في هذا الملف):
--     * impressions: آخر 7 أيام
--     * view events: آخر 14 يوماً
--     * feedback:    بلا نافذة (رأي واحد لكل مستخدم/منشور، ويُقرأ كحالة)
--
--   منع تضاعف الصفوف: كل جدول إشارات يُجمَّع أولاً في CTE واحد لكل post_id،
--   ثم يُنضم LEFT JOIN مرة واحدة. لا يُنضم جدول أحداث خام إلى المرشحين
--   مباشرة، فلا يتضاعف صف المنشور بعدد انطباعاته أو مشاهداته.
--
--   لا خلط بين impression و view event: لكل منهما CTE مستقل ودلالة مستقلة.
--
-- ---------------------------------------------------------------------
-- سياسة الحصص: أهداف (targets) لا حصص مضمونة
-- ---------------------------------------------------------------------
--   النسب ثابتة: متابعات 50%، استكشاف 35%، إعادات نشر 15% من السقف.
--   الحصص تُحسب بالتتابع وتُقصّ على ما بقي، فمجموعها يساوي v_candidates
--   ولا يتجاوزه أبداً، حتى عند v_candidates = 1 أو 2 أو 3:
--     1 ⇒ متابعات 1، استكشاف 0، إعادات نشر 0
--     2 ⇒ متابعات 1، استكشاف 1، إعادات نشر 0
--     3 ⇒ متابعات 2، استكشاف 1، إعادات نشر 0
--     160 ⇒ متابعات 80، استكشاف 56، إعادات نشر 24
--
--   ما لا يُضمن صراحةً:
--     * إن لم يوجد في المصدر نفسه عدد كافٍ من الصفوف المؤهلة (نافذة زمنية
--       أو خصوصية أو حجب أو إعادات نشر ناقصة) فلن تُستوفى حصته. هذا حدّ
--       بيانات لا حدّ تنفيذ، ويُعوَّض عنه إجمالاً من المصادر الأخرى.
--     * الحصة ليست عقداً: الترتيب النهائي يقرأ ما توفّر، والعدد الكلي
--       يُكمَّل قدر الإمكان بلا تجاوز v_candidates.
--
--   ما يُضمن فعلياً (بآلية في الاستعلام نفسه، لا بالادعاء):
--     * لا يستهلك صفٌّ مكاناً في أكثر من مصدر واحد، والفصل **بقواعد الأهلية
--       لا بحدود القوائم**:
--         - discovery_slice يستبعد كل منشورات الحسابات المتابَعة عبر
--           followed_authors، لا صفوف follow_slice المقصوصة فقط.
--         - repost_slice يستبعد المؤهل للمصدرين معاً بقواعد الأهلية الكاملة
--           (نفس شروط الفرعين)، لا صفوف الشرائح المقصوصة.
--       فمنشور من حساب أتابعه لا يمكن أن يستهلك حصة الاستكشاف لمجرد أنه لم
--       يقع في أول v_bound_follow صفاً.
--     * إعادات النشر تُزال تكراراتها داخلياً (أحدث إعادة نشر لكل منشور)
--       قبل القصّ، فلا تستهلك إعادات المنشور نفسه أكثر من مكان واحد.
--     * حد القراءة لكل مصدر ≥ حصته + 20 دائماً، فالمصدر يرى من الصفوف ما
--       يكفي لتغطية حصته إن كانت الصفوف موجودة.
--     * مجموع الحصص = v_candidates، والتعويض الإجمالي لا يتجاوز السقف.
--   بهذا يصبح استيفاء الحصة **مشروطاً بتوفر البيانات في المصدر نفسه** فقط،
--   لا بمقدار التداخل بين المصادر — وهو أقوى ضمان ممكن داخل قراءة محدودة.
--   الحد الوحيد المتبقي: إن كان المصدر نفسه أقصر من حصته داخل حدّه، فلا
--   يُستوفى، ويُعوَّض إجمالاً لا لكل مصدر.
--
-- ---------------------------------------------------------------------
-- كلفة الاستعلام — ما يضمنه LIMIT وما لا يضمنه
-- ---------------------------------------------------------------------
--   LIMIT يحدّ **الصفوف التي يُخرجها** الفرع، لا الصفوف التي **يفحصها**
--   المنفّذ. مع ORDER BY قد يفحص المنفّذ كل الصفوف المطابقة ثم يُبقي أفضل
--   N (top-N heapsort)، ولا يتوقف مبكراً إلا إذا أمكن تنفيذ الترتيب بمؤشر
--   يسمح بالتوقف المبكر (Index Scan على مفتاح الترتيب مع تحقّق الفلاتر على
--   الصفوف المقروءة).
--
--   لذلك: `limit v_bound_*` يضمن حداً أعلى لعدد الصفوف **الناتجة** من كل
--   مصدر (≤ 240 × 3 = 720 قبل الدمج)، **ولا يضمن** أن المسح نفسه محدود،
--   ولا أن المؤشر مستخدم. تأكيد ذلك يحتاج EXPLAIN (ANALYZE, BUFFERS) على
--   قاعدة حقيقية، ولم يُنفَّذ هنا.
--
--   الفهارس القائمة التي قد تخدم هذا الاستعلام (من schema.sql وترحيلاتها،
--   بلا إضافة أي فهرس في هذا الملف):
--     * posts_created_at_idx (created_at desc)
--       → ترتيب المتابعات والاستكشاف.
--     * posts_user_created_at_idx (user_id, created_at desc)
--       → مسار المتابعات عبر حسابات المتابَعين.
--     * aani_reposts_user_idx (user_id)   ← تصحيح: هذا هو الموجود فعلاً
--       في الإنتاج (20261026000000 سطر 59، ونفسه في schema.sql سطر 667).
--       **لا يوجد** reposts_user_created_idx (user_id, created_at DESC):
--       الفحص المباشر على Production لم يجده. لذلك فلترة
--       `repost.created_at >= now() - interval '30 days'` **لا يضمنها فهرس
--       مركّب**: المؤشر يخدم شرط user_id فقط، ثم تُفحص created_at كفلتر على
--       الصفوف المقروءة، والترتيب `repost.created_at desc` يحتاج خطوة ترتيب
--       (Sort) ولا يستفيد من المؤشر للترتيب. لا أضيف مؤشراً هنا؛ هذا قرار
--       منفصل يحتاج EXPLAIN قبل وبعد.
--     * aani_reposts_post_user_unique (post_id, user_id)
--       ← تصحيح: هذا هو الموجود فعلاً في الإنتاج
--       (20261026000000 سطر 44 وschema.sql سطر 652، قيد unique داخل الجدول).
--       **لا يوجد فهرس مستقل باسم reposts_post_idx (post_id)**؛ الإشارة
--       السابقة إليه كانت خاطئة وقد حُذفت. post_id هو **العمود الأول** في
--       هذا الفهرس المركّب، ولذلك يمكن أن يخدم استعلامات البحث بـ post_id
--       (مثل ربط إعادة النشر بمنشورها و`post_id in (select … from candidates)`)،
--       لأن العمود البادئ في فهرس مركّب صالح للبحث والربط بمفرده. أما
--       user_id فهو العمود الثاني، فلا يخدم البحث به وحده في هذا الفهرس؛
--       وله فهرس مستقل هو aani_reposts_user_idx أعلاه.
--     * post_impressions_user_time_idx (user_id, impression_at desc)
--     * post_view_events_user_post_time_idx (user_id, post_id, event_at desc)
--     * aani_post_feedback_user_idx (user_id, updated_at desc)
--       → مسح سجلات المستخدم في النوافذ الزمنية.
--   ولا يوجد مؤشر على (user_id, post_id) في post_impressions، فالمسح هناك
--   قد يمرّ على سجلات المستخدم في النافذة ثم يُفلتر بـ post_id.
--
--   بعد تحديد المرشحين (≤ v_candidates، أي ≤ 160):
--     * تجميع post_impressions و post_view_events و post_feedback مقيَّد
--       بـ post_id in (select post_id from candidates)، فالدلالة والقيم
--       نفسها، والمقروء أقل بمقدار عدد المنشورات غير المرشحة.
--     * repost_latest مقيَّد بنفس المجموعة، فلا تُقرأ إعادات نشر غير مرشحة.
--   كلا القيدين لا يوسّع RLS: يبقى user_id = auth.uid() على جداول الإشارات،
--   وتبقى سياسة reposts الحالية كما هي دون أي صلاحية إضافية.
--
--   التزام صريح: هذا الملف **لا يضيف أي فهرس ولا يعدّل قاعدة البيانات**.
--   أي فهرس إضافي (مثل post_impressions (user_id, post_id)) قرار منفصل
--   يحتاج EXPLAIN قبل وبعد، ولم يُتخذ هنا.
--
--   ملاحظة على قراءة إعادات النشر: إزالة تكرارها الداخلي تحتاج معرفة أحدث
--   إعادة نشر لكل منشور، وهي تُحسب داخل الفرع قبل القصّ. لا يوجد `limit`
--   داخلي على هذا التجميع، لكن صفوفه محدودة بطبيعتها: سياسة القراءة الحالية
--   على reposts تحصرها في إعادات المستخدم نفسه، ونافذتها 30 يوماً، ويدعمها
--   aani_reposts_user_idx على user_id وحده. لا أدّعي أنه مسح محدود بحدّ
--   ثابت، ولا أن فلترة created_at أو الترتيب يستفيدان من مؤشر؛ هذا يحتاج
--   EXPLAIN للتأكيد.
--
-- ---------------------------------------------------------------------
-- الحسابات المعطّلة (is_deactivated) — القاعدة المعتمدة وأدلتها
-- ---------------------------------------------------------------------
--   الأدلة من المصدر:
--     * 20261224000000 سطر 6: تعليق العمود ينصّ أن is_deactivated يعني
--       «تعطيل الحساب مؤقتاً حتى يسجل المستخدم الدخول مجدداً» — أي حالة
--       غياب مؤقتة، لا حذف ولا إخفاء محتوى.
--     * useAppSession.ts سطر 70-72: يُعاد تعيين is_deactivated = false فور
--       تسجيل الدخول، فتأكيد أنه مؤقت.
--     * 20270201000000 سطر 133-134 و20270206000000 سطر 394-395: تُستبعد
--       الحسابات المعطّلة من قائمة «الأشخاص القريبون» (aani_nearby_people)
--       ومن الفهرس الجزئي profiles_city_key_nearby_idx. أي أنها تُستبعد من
--       **واجهات الاكتشاف** لا من قراءة المحتوى.
--     * لا توجد أي سياسة RLS على posts أو media أو تفاعلات تذكر
--       is_deactivated. و aani_can_read_post (20270203000000) لا تفحصه
--       إطلاقاً، فمنشورات الحساب المعطّل تبقى مقروءة لمن يملك حق قراءتها.
--     * usePosts.ts لا يفلتر is_deactivated (لا ذكر له في الملف)،
--       و FollowListView.tsx سطر 131-140 يجلبه للعرض ولا يستبعد به أحداً.
--   الخلاصة المدعومة بالأدلة: التعطيل يُخرج الحساب من مسارات الاكتشاف،
--   ويُبقي محتواه متاحاً في المسارات القائمة على علاقة صريحة (متابعة، أو
--   إعادة نشر قام بها المستخدم نفسه). لذلك:
--     * follow_slice **لا يستبعد** الحساب المتابَع المعطّل — مقصود ومتسق
--       مع غياب الفحص في aani_can_read_post وفي usePosts.
--     * discovery_slice **يستبعد** الحساب المعطّل — متسق مع aani_nearby_people
--       (الاستكشاف واجهة اكتشاف لغير المتابَعين).
--     * repost_slice متسق مع الاثنين: «المؤهل للمتابعات» لا يفحص التعطيل،
--       و«المؤهل للاستكشاف» يفحصه، فتأتي شروطه مطابقة حرفياً لشروط الفرعين.
--       وإعادات النشر هنا هي إعادات المستخدم نفسه (سياسة reposts الحالية)،
--       أي علاقة صريحة، فبقاء منشور حساب معطّل عبرها متسق مع القاعدة.
--   القرار المعلَّق (يحتاج اعتماداً، ولم أغيّره): لو رُغب في استبعاد
--   الحسابات المعطّلة من التغذية كلها — بما فيها منشورات المتابَعين —
--   فالتعديل الأدنى هو إضافة `and not owner.is_deactivated` إلى follow_slice
--   مع ضمّ profiles، وإضافة `and not post_owner.is_deactivated` إلى شرط
--   «المؤهل للمتابعات» في repost_slice. لم أنفّذه لأن الأدلة لا تدعمه.
--
-- ---------------------------------------------------------------------
-- حداثة إعادة النشر (بند 2)
-- ---------------------------------------------------------------------
--   لكل مرشح عمودان زمنيان منفصلان:
--     * post_created_at: تاريخ نشر المنشور الأصلي، لا يُغيَّر ولا يُستبدل.
--     * candidate_at   : حداثة المرشح — post.created_at للمتابعة والاستكشاف،
--                        وrepost.created_at لإعادة النشر.
--   repost.created_at هو أساس حداثة مرشح إعادة النشر وأولويته داخل حصته.
--   درجة الحداثة في الترتيب تستخدم candidate_at، وكاسر التعادل النهائي
--   يستخدم post_created_at.
--   إسناد إعادة النشر (reposter_id و reposted_at) يُؤخذ من أحدث إعادة نشر
--   للمنشور بعد اختيار الصف، فلا يُفقد حتى لو كان المصدر المُحتسب متابعة.
-- =====================================================================
begin;

create or replace function public.get_personalized_feed(
  p_limit integer default 20,
  p_candidate_limit integer default 80
)
returns table (
  post_id uuid,
  reposter_id uuid,
  reposted_at timestamptz,
  rank_position integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  -- الهوية من الجلسة فقط. لا تُقبل من الواجهة ولا من المدخلات.
  v_viewer uuid := auth.uid();
  -- تقييد المدخلات: أي قيمة خارج النطاق تُقصّ بأمان، و NULL يأخذ الافتراضي.
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 40);
  v_candidates integer := least(greatest(coalesce(p_candidate_limit, 80), 1), 160);
  -- حصص المصادر: أهداف تُحسب بالتتابع بأولوية ثابتة (المتابعات ثم الاستكشاف
  -- ثم إعادات النشر). كل حصة تُقصّ على ما بقي من السقف، فمجموع الحصص يساوي
  -- v_candidates تماماً ولا يتجاوزه أبداً — حتى عند v_candidates = 1 أو 2 أو 3.
  -- النسب الداخلية المعتمدة: 50% متابعات، 35% استكشاف، 15% إعادات نشر.
  v_quota_follow integer;
  v_quota_reposts integer;
  v_quota_discovery integer;
  -- حد الناتج لكل مصدر: يحدّ عدد الصفوف التي يُخرجها الفرع، لا عدد ما يفحصه
  -- المنفّذ (انظر رأس الملف). يُحسب كالتالي:
  --   least(240, greatest(quota * 3, quota + 20))
  -- والنتيجة أنه ≥ الحصة + 20 دائماً (أقصى حصة 80)، فالمصدر يرى ما يكفي
  -- لتغطية حصته إن كانت الصفوف موجودة، ولا يزيد أي حد على 240.
  v_bound_follow integer;
  v_bound_discovery integer;
  v_bound_reposts integer;
begin
  -- بلا هوية: لا منشورات إطلاقاً.
  if v_viewer is null then
    return;
  end if;

  -- سقف المرشحين لا يقل عن المطلوب إرجاعه (يبقى ≤ 160 دائماً لأن الحد 40).
  v_candidates := greatest(v_candidates, v_limit);

  -- 1) المتابعات: 50% مع صف واحد على الأقل، ولا تتجاوز السقف.
  v_quota_follow := least(
    v_candidates,
    greatest(1, ceil(v_candidates::numeric * 0.50)::integer)
  );
  -- 2) الاستكشاف: 35% مما بقي، ويُخدَم قبل إعادات النشر عند ضيق السقف.
  v_quota_discovery := least(
    v_candidates - v_quota_follow,
    greatest(0, ceil(v_candidates::numeric * 0.35)::integer)
  );
  -- 3) إعادات النشر: الباقي (الهدف 15%). قد يكون صفراً في السقوف الصغيرة.
  v_quota_reposts := v_candidates - v_quota_follow - v_quota_discovery;

  -- سقوف القراءة لكل مصدر (≤ 240 دائماً).
  v_bound_follow := least(240, greatest(v_quota_follow * 3, v_quota_follow + 20));
  v_bound_discovery := least(240, greatest(v_quota_discovery * 3, v_quota_discovery + 20));
  v_bound_reposts := least(240, greatest(v_quota_reposts * 3, v_quota_reposts + 20));

  return query
  with followed_authors as (
    -- 1) شبكة المتابعة: من أتابعه أنا (follower_id = أنا) — مقروء تحت سياسة
    --    follows الحالية (متساهلة using(true) + حارس restrictive يسمح بصف
    --    المشاهد نفسه). صف في follows يعني متابعة معتمدة.
    --    تُحسب أولاً لأنها تُستخدم في بناء المرشحين، والإشارات تُجمَّع بعد
    --    تحديد المرشحين لتقتصر على post_id المرشحة.
    select relation.following_id as author_id
    from public.follows as relation
    where relation.follower_id = v_viewer
  ),
  -- -------------------------------------------------------------------
  -- 2) المرشحون الخام: ثلاثة مصادر مفصولة **بقواعد الأهلية** لا بحدود القوائم.
  --    LIMIT هنا يحدّ **الناتج** من كل فرع، ولا يضمن أن المسح نفسه محدود
  --    (انظر رأس الملف). الفروع مرتّبة بترتيب حتمي وكاسر تعادل ثابت.
  --
  --    source_rank يحدد أولوية الإسناد عند التداخل:
  --        1) المتابعات   2) الاستكشاف   3) إعادات النشر
  --
  --    **الفصل بالأهلية لا بالشريحة** — وهذا هو الإصلاح الأساسي:
  --    الاعتماد على «استبعاد ما ورد في follow_slice» كان يترك منشوراً من
  --    حساب أتابعه (لم يقع في أول v_bound_follow صفاً) يستهلك حصة
  --    الاستكشاف، وهذا خطأ. الآن:
  --      * discovery_slice يستبعد **كل منشورات الحسابات المتابَعة** عبر
  --        followed_authors مباشرةً، لا عبر الصفوف المقصوصة. ونوافذ المصدرين
  --        متداخلة (14 داخل 30)، فكل منشور متابَع داخل نافذة الاستكشاف هو
  --        بالضرورة مؤهل للمتابعات. لا حاجة لقراءة غير محدودة.
  --      * repost_slice يستبعد المنشورات المؤهلة للمصدرين معاً بقواعد
  --        الأهلية الكاملة نفسها (نفس الشروط المستخدمة أعلاه)، لا بصفوف
  --        الشرائح المقصوصة. ولأن الاستكشاف يستبعد المتابَعين، تنقسم
  --        الأهلية إلى:
  --          (أ) صاحب المنشور متابَع  و post.created_at ضمن 30 يوماً
  --          (ب) صاحب المنشور غير متابَع، والمنشور غير خاص، وصاحبه غير خاص
  --              وغير معطّل، و post.created_at ضمن 14 يوماً
  --        وما لا يطابق (أ) ولا (ب) هو وحده ما يدخل مصدر إعادات النشر.
  --
  --    الأثر: حصة كل مصدر لا تُستهلك إلا بصفوف تخصّه فعلاً، فاستيفاء الحصة
  --    صار مشروطاً بتوفر البيانات في المصدر نفسه فقط. ولا صف يُقرأ أكثر من
  --    مرة إلا بصفته المؤهلة، ولا تُضاف قراءة غير محدودة ولا فهرس.
  --
  --    إعادات النشر تُزال تكراراتها داخلياً قبل القصّ: أحدث إعادة نشر لكل
  --    منشور (created_at desc ثم user_id ثم post_id)، فلا تستهلك إعادات
  --    المنشور نفسه أكثر من مكان واحد في الحصة.
  --
  --    عمودان زمنيان منفصلان:
  --      * post_created_at : تاريخ نشر المنشور الأصلي — لا يُغيَّر أبداً.
  --      * candidate_at    : حداثة المرشح؛ post.created_at للمتابعة
  --                          والاستكشاف، وrepost.created_at لإعادة النشر.
  -- -------------------------------------------------------------------
  follow_slice as (
    select
      post.id as post_id,
      post.created_at as post_created_at,
      post.created_at as candidate_at,
      post.user_id as author_id,
      coalesce(post.likes_count, 0) as likes_count,
      coalesce(post.comments_count, 0) as comments_count,
      coalesce(post.reposts_count, 0) as reposts_count
    from public.posts as post
    join followed_authors as followed on followed.author_id = post.user_id
    where post.created_at >= now() - interval '30 days'
      -- لا فحص لـ is_deactivated هنا بقصد: التعطيل مؤقت ويُخرج الحساب من
      -- واجهات الاكتشاف فقط، بينما aani_can_read_post و usePosts لا يفحصانه،
      -- فمنشورات الحساب المتابَع المعطّل تبقى ظاهرة لمتابعيه. التفصيل في رأس
      -- الملف ضمن «الحسابات المعطّلة». أي تغيير هنا قرار اعتماد لا إصلاح.
    order by post.created_at desc, post.id asc
    limit v_bound_follow
  ),
  discovery_slice as (
    select
      post.id,
      post.created_at,
      post.created_at,
      post.user_id,
      coalesce(post.likes_count, 0),
      coalesce(post.comments_count, 0),
      coalesce(post.reposts_count, 0)
    from public.posts as post
    join public.profiles as owner on owner.id = post.user_id
    where coalesce(post.visibility, 'public') <> 'private'
      and owner.is_private = false
      and owner.is_deactivated = false
      and post.created_at >= now() - interval '14 days'
      -- كل منشورات الحسابات المتابَعة تخصّ مصدر المتابعات، سواء وقعت في
      -- شريحته المقصوصة أو لم تقع. الفصل بالأهلية لا بالشريحة.
      and not exists (
        select 1
        from followed_authors as followed
        where followed.author_id = post.user_id
      )
    order by post.created_at desc, post.id asc
    limit v_bound_discovery
  ),
  repost_slice as (
    select
      latest.post_id,
      latest.post_created_at,
      latest.reposted_at as candidate_at,
      latest.author_id,
      latest.likes_count,
      latest.comments_count,
      latest.reposts_count
    from (
      select
        repost.post_id,
        post.created_at as post_created_at,
        repost.created_at as reposted_at,
        post.user_id as author_id,
        coalesce(post.likes_count, 0) as likes_count,
        coalesce(post.comments_count, 0) as comments_count,
        coalesce(post.reposts_count, 0) as reposts_count,
        row_number() over (
          partition by repost.post_id
          order by repost.created_at desc, repost.user_id asc, repost.post_id asc
        ) as repost_position
      from public.reposts as repost
      join public.posts as post on post.id = repost.post_id
      join public.profiles as post_owner on post_owner.id = post.user_id
      where repost.created_at >= now() - interval '30 days'
        -- استبعاد المؤهل لمصدر المتابعات: صاحب متابَع ومنشور ضمن 30 يوماً.
        and not (
          post.created_at >= now() - interval '30 days'
          and exists (
            select 1
            from followed_authors as followed
            where followed.author_id = post.user_id
          )
        )
        -- استبعاد المؤهل لمصدر الاستكشاف: صاحب غير متابَع، ومنشور غير خاص،
        -- وصاحب غير خاص وغير معطّل، وضمن 14 يوماً. نفس قواعد discovery_slice.
        and not (
          post.created_at >= now() - interval '14 days'
          and coalesce(post.visibility, 'public') <> 'private'
          and post_owner.is_private = false
          and post_owner.is_deactivated = false
          and not exists (
            select 1
            from followed_authors as followed
            where followed.author_id = post.user_id
          )
        )
    ) as latest
    where latest.repost_position = 1
    order by latest.reposted_at desc, latest.post_id asc
    limit v_bound_reposts
  ),
  raw_candidates as (
    select 1 as source_rank, follow_slice.* from follow_slice
    union all
    select 2 as source_rank, discovery_slice.* from discovery_slice
    union all
    select 3 as source_rank, repost_slice.* from repost_slice
  ),
  -- -------------------------------------------------------------------
  -- 3) إسناد واحد حتمي لكل post_id.
  --
  --    الفصل بين المصادر تمّ بقواعد الأهلية في الفرعين السابقين، فالقوائم
  --    الثلاث منفصلة بالفعل. هذه الكتلة شبكة أمان حتمية: لو تكرّر post_id
  --    لأي سبب (تعديل لاحق، أو إعادة نشر متعددة تجاوزت إزالة التكرار)،
  --    يُختار صف واحد بأولوية ثابتة 1) المتابعات 2) الاستكشاف 3) إعادات
  --    النشر، ثم candidate_at ثم post_id. فلا يعتمد الاختيار على ترتيب الفحص.
  -- -------------------------------------------------------------------
  assigned as (
    select
      candidate.post_id,
      candidate.source_rank,
      candidate.post_created_at,
      candidate.candidate_at,
      candidate.author_id,
      candidate.likes_count,
      candidate.comments_count,
      candidate.reposts_count,
      row_number() over (
        partition by candidate.post_id
        order by
          candidate.source_rank asc,
          candidate.candidate_at desc,
          candidate.post_id asc
      ) as assignment_position
    from raw_candidates as candidate
  ),
  one_per_post as (
    select
      assigned.post_id,
      assigned.source_rank,
      assigned.post_created_at,
      assigned.candidate_at,
      assigned.author_id,
      assigned.likes_count,
      assigned.comments_count,
      assigned.reposts_count
    from assigned
    where assigned.assignment_position = 1
  ),
  -- إشارة المتابعة وإسناد إعادة النشر.
  -- إسناد إعادة النشر (reposter_id و reposted_at) لا يُحسب هنا: يُقرأ بعد
  -- تحديد المرشحين النهائيين فقط (repost_latest)، فلا تُقرأ إعادات نشر غير
  -- مرشحة، ولا يُفقد الإسناد إن اختير الصف من مصدر متابعة أو استكشاف.
  attributed as (
    select
      one_per_post.post_id,
      one_per_post.source_rank,
      one_per_post.post_created_at,
      one_per_post.candidate_at,
      one_per_post.author_id,
      one_per_post.likes_count,
      one_per_post.comments_count,
      one_per_post.reposts_count,
      exists (
        select 1
        from followed_authors as followed
        where followed.author_id = one_per_post.author_id
      ) as from_follow
    from one_per_post
  ),
  -- -------------------------------------------------------------------
  -- 4) الحصص: تُطبَّق على قائمة فريدة ومفصولة المصادر، وترتيب الترقيم داخل
  --    كل مصدر حتمي (candidate_at ثم post_id).
  --
  --    ما تحققه هذه الكتلة: لا صف مكرر يستهلك مكاناً، ولا صف من مصدر أسبق
  --    يستهلك مكاناً في مصدر لاحق. فالحصة تُستوفى متى وُجد في المصدر نفسه
  --    ≥ حصته من الصفوف المؤهلة داخل حدّه (وحدّه ≥ الحصة + 20 دائماً).
  --
  --    ما لا تحققه: إن كان المصدر نفسه أقصر من حصته (لا صفوف مؤهلة كافية)
  --    فلا يمكن استيفاء الحصة، ويُعوَّض النقص إجمالاً في الكتلة التالية.
  -- -------------------------------------------------------------------
  quota_ranked as (
    select
      attributed.*,
      row_number() over (
        partition by attributed.source_rank
        order by attributed.candidate_at desc, attributed.post_id asc
      ) as source_position
    from attributed
  ),
  quota_selected as (
    select *
    from quota_ranked
    where quota_ranked.source_position <= case quota_ranked.source_rank
      when 1 then v_quota_follow
      when 2 then v_quota_discovery
      else v_quota_reposts
    end
  ),
  -- -------------------------------------------------------------------
  -- 4ب) تعويض الحصص غير المستهلكة: إن كان أحد المصادر أقل من حصته يُملأ
  --     الباقي من أفضل المرشحين الفريدين المتبقين، بأولوية المصدر نفسها
  --     (المتابعات ثم الاستكشاف ثم إعادات النشر) ثم candidate_at ثم post_id.
  --     لا يتجاوز المجموع v_candidates أبداً.
  -- -------------------------------------------------------------------
  quota_overflow as (
    select
      quota_ranked.*,
      row_number() over (
        order by
          quota_ranked.source_rank asc,
          quota_ranked.candidate_at desc,
          quota_ranked.post_id asc
      ) as overflow_position
    from quota_ranked
    where not exists (
      select 1
      from quota_selected as selected
      where selected.post_id = quota_ranked.post_id
    )
  ),
  candidates as (
    select
      quota_selected.post_id,
      quota_selected.source_rank,
      quota_selected.post_created_at,
      quota_selected.candidate_at,
      quota_selected.author_id,
      quota_selected.from_follow,
      quota_selected.likes_count,
      quota_selected.comments_count,
      quota_selected.reposts_count
    from quota_selected

    union all

    select
      quota_overflow.post_id,
      quota_overflow.source_rank,
      quota_overflow.post_created_at,
      quota_overflow.candidate_at,
      quota_overflow.author_id,
      quota_overflow.from_follow,
      quota_overflow.likes_count,
      quota_overflow.comments_count,
      quota_overflow.reposts_count
    from quota_overflow
    where quota_overflow.overflow_position <= greatest(
      0,
      v_candidates - (select count(*)::integer from quota_selected)
    )
  ),
  -- -------------------------------------------------------------------
  -- 5) تجميع الإشارات مقتصراً على post_id المرشحة فقط.
  --    مجموعة القيد ≤ v_candidates (≤ 160 post_id) بعد الدمج والحصص، فكل
  --    قراءة من جداول الإشارات تُفلتر بها بدل المرور على سجلات المستخدم
  --    كلها في النافذة. هذا يقلّل الصفوف الناتجة والصفوف المرشّحة للفحص،
  --    لكنه لا يحوّل المسح إلى مسح محدود بحدّ ثابت: قد يمرّ المنفّذ على
  --    فهرس المستخدم في النافذة ثم يفلتر. يحتاج EXPLAIN للتأكيد.
  --    القيد بـ `in (select post_id from candidates)` لا يتجاوز RLS: كل جدول
  --    إشارات يبقى مقروءاً بصلاحيات المستخدم وشرط user_id = auth.uid()،
  --    فالدلالة نفسها ولا تتغير قيم أي إشارة.
  --
  --    completion_ratio قد يكون NULL، فتُحسب القيم المعروفة على حدة:
  --      * completion_known_count: عدد الأحداث ذات completion_ratio غير NULL.
  --      * avg_completion: متوسط القيم المعروفة فقط، أو NULL إن لم توجد.
  --    ولا تُعامَل قيمة NULL أبداً كإكمال صفري.
  --    early_skip و replay_count إشارات مستقلة ولم تُمسّ.
  -- -------------------------------------------------------------------
  signal_impressions as (
    select
      impression.post_id,
      count(*)::integer as impression_count
    from public.post_impressions as impression
    where impression.user_id = v_viewer
      and impression.impression_at >= now() - interval '7 days'
      and impression.post_id in (select candidate.post_id from candidates as candidate)
    group by impression.post_id
  ),
  signal_views as (
    select
      view_event.post_id,
      count(*)::integer as view_count,
      count(view_event.completion_ratio)::integer as completion_known_count,
      avg(view_event.completion_ratio)::numeric as avg_completion,
      count(*) filter (where view_event.early_skip)::integer as early_skip_count,
      -- bigint لا integer: مجموع replay_count قد يتجاوز مدى integer.
      coalesce(sum(view_event.replay_count), 0)::bigint as replay_total
    from public.post_view_events as view_event
    where view_event.user_id = v_viewer
      and view_event.event_at >= now() - interval '14 days'
      and view_event.post_id in (select candidate.post_id from candidates as candidate)
    group by view_event.post_id
  ),
  signal_feedback as (
    select
      feedback.post_id,
      bool_or(feedback.feedback = 'interested') as interested,
      bool_or(feedback.feedback = 'not_interested') as not_interested
    from public.post_feedback as feedback
    where feedback.user_id = v_viewer
      and feedback.post_id in (select candidate.post_id from candidates as candidate)
    group by feedback.post_id
  ),
  -- -------------------------------------------------------------------
  -- 6) أحدث إعادة نشر متاحة للمستخدم لكل منشور مرشح فقط.
  --    مقروءة تحت سياسة القراءة الحالية على reposts
  --    (aani_reposts_select_own + الحارس restrictive) بلا أي توسيع، ومع
  --    SECURITY INVOKER فلا صف يظهر بغير صلاحية المستخدم.
  --    الترتيب حتمي: repost.created_at desc ثم user_id ثم post_id.
  -- -------------------------------------------------------------------
  repost_latest as (
    select
      ranked.post_id,
      ranked.reposter_id,
      ranked.reposted_at
    from (
      select
        repost.post_id,
        repost.user_id as reposter_id,
        repost.created_at as reposted_at,
        row_number() over (
          partition by repost.post_id
          order by repost.created_at desc, repost.user_id asc, repost.post_id asc
        ) as repost_position
      from public.reposts as repost
      where repost.post_id in (select candidate.post_id from candidates as candidate)
    ) as ranked
    where ranked.repost_position = 1
  ),
  -- -------------------------------------------------------------------
  -- 7) الإشارات تُنضم LEFT JOIN مرة واحدة لكل منشور، بعد التجميع المسبق.
  --     غياب أي إشارة = 0 عبر COALESCE، لا استبعاد ولا تعطيل للترتيب.
  -- -------------------------------------------------------------------
  scored as (
    select
      candidate.post_id,
      repost_latest.reposter_id,
      repost_latest.reposted_at,
      candidate.author_id,
      candidate.post_created_at,
      candidate.from_follow,
      coalesce(impression_signal.impression_count, 0) as impression_count,
      coalesce(view_signal.view_count, 0) as view_count,
      -- متوسط الإكمال يبقى NULL إن لم توجد قيمة معروفة واحدة، ولا يتحول
      -- إلى صفر لأنه ليس مشاهدة غير مكتملة.
      view_signal.avg_completion as avg_completion,
      coalesce(view_signal.completion_known_count, 0) as completion_known_count,
      coalesce(view_signal.early_skip_count, 0) as early_skip_count,
      coalesce(view_signal.replay_total, 0) as replay_total,
      coalesce(feedback_signal.interested, false) as interested,
      coalesce(feedback_signal.not_interested, false) as not_interested,
      -- حداثة محدودة بين 0 و1: تنقص خلال 48 ساعة ولا تصبح سالبة.
      -- تعتمد على candidate_at: تاريخ المنشور الأصلي لمنشورات المتابعة
      -- والاستكشاف، وتاريخ إعادة النشر لإعادات النشر.
      (
        1.0 / (
          1.0 + greatest(
            extract(epoch from (now() - candidate.candidate_at))::numeric / 3600.0,
            0::numeric
          ) / 48.0
        )
      )::numeric as recency_score,
      -- تفاعل عام من أعمدة posts الموجودة أصلاً (لا تُقرأ جداول أخرى).
      -- greatest(..., 0) يحمي ln من أي عدّاد سالب غير متوقع: لا استثناء ولا
      -- فشل للدالة بسبب بيانات شاذة.
      ln(
        1::numeric
        + greatest(candidate.likes_count, 0)::numeric
        + 2::numeric * greatest(candidate.comments_count, 0)::numeric
        + 2::numeric * greatest(candidate.reposts_count, 0)::numeric
      ) as engagement_raw
    from candidates as candidate
    left join repost_latest on repost_latest.post_id = candidate.post_id
    left join signal_impressions as impression_signal
      on impression_signal.post_id = candidate.post_id
    left join signal_views as view_signal
      on view_signal.post_id = candidate.post_id
    left join signal_feedback as feedback_signal
      on feedback_signal.post_id = candidate.post_id
  ),
  -- -------------------------------------------------------------------
  -- 8) الدرجة: أوزان صريحة ومحدودة وقابلة للمراجعة.
  --    القاعدة: غياب الإشارات الشخصية = صفر، وليس عقوبة.
  --      * حداثة            : 0 .. 1      (الوزن الأساسي 1.00)
  --      * متابعة           : +0.35
  --      * interested       : +0.60
  --      * not_interested   : -1.20      (إشارة صريحة، لا غياب إشارة)
  --      * تفاعل عام        : 0 .. +0.20 (ln مقصوص)
  --      * إكمال مشاهدة     : -0.05 .. +0.05 حول 0.5، **فقط** عند وجود قيمة
  --                            completion_ratio معروفة واحدة على الأقل.
  --                            غياب القيمة ليس إكمالاً صفرياً ولا عقوبة.
  --      * تكرار مشاهدة     : +0.05      فقط عند وجود إعادة تشغيل
  --      * إشباع انطباعات   : 0 .. -0.15 فقط عند وجود انطباعات سابقة
  --      * تخطٍ مبكر        : 0 .. -0.10 فقط عند وجود مشاهدات
  -- -------------------------------------------------------------------
  weighted as (
    select
      scored.post_id,
      scored.reposter_id,
      scored.reposted_at,
      scored.author_id,
      scored.post_created_at,
      (
        scored.recency_score
        + case when scored.from_follow then 0.35::numeric else 0::numeric end
        + case when scored.interested then 0.60::numeric else 0::numeric end
        + case when scored.not_interested then -1.20::numeric else 0::numeric end
        + least(0.20::numeric, scored.engagement_raw * 0.03::numeric)
        + case
            when scored.completion_known_count > 0 and scored.avg_completion is not null
              then (scored.avg_completion - 0.5::numeric) * 0.10::numeric
            else 0::numeric
          end
        + case when scored.replay_total > 0 then 0.05::numeric else 0::numeric end
        - case
            when scored.impression_count > 0
              then least(0.15::numeric, ln(1::numeric + scored.impression_count::numeric) * 0.03::numeric)
            else 0::numeric
          end
        - case
            when scored.view_count > 0
              then least(
                0.10::numeric,
                (scored.early_skip_count::numeric / scored.view_count::numeric) * 0.10::numeric
              )
            else 0::numeric
          end
      )::numeric as base_score
    from scored
  ),
  -- -------------------------------------------------------------------
  -- 9) تنويع المؤلفين: ترتيب حتمي داخل كل مؤلف، ثم خصم متدرّج مقصوص
  --     لتقليل تتابع الحساب نفسه. الخصم لا يقلب ترتيب المنشورات القديمة
  --     ولا يحذف شيئاً.
  -- -------------------------------------------------------------------
  author_ranked as (
    select
      weighted.*,
      row_number() over (
        partition by weighted.author_id
        order by weighted.base_score desc, weighted.post_created_at desc, weighted.post_id asc
      ) as author_position
    from weighted
  ),
  diversified as (
    select
      author_ranked.post_id,
      author_ranked.reposter_id,
      author_ranked.reposted_at,
      author_ranked.post_created_at,
      (
        author_ranked.base_score
        - least(
            0.25::numeric,
            0.05::numeric * (author_ranked.author_position - 1)::numeric
          )
      )::numeric as final_score
    from author_ranked
  ),
  -- -------------------------------------------------------------------
  -- 10) الترتيب النهائي حتمي دائماً: الدرجة، ثم تاريخ نشر المنشور الأصلي،
  --     ثم post_id. لا تعادل بلا كاسر.
  -- -------------------------------------------------------------------
  final_ranking as (
    select
      diversified.post_id,
      diversified.reposter_id,
      diversified.reposted_at,
      (
        row_number() over (
          order by
            diversified.final_score desc,
            diversified.post_created_at desc,
            diversified.post_id asc
        )
      )::integer as rank_position
    from diversified
  )
  select
    final_ranking.post_id,
    final_ranking.reposter_id,
    final_ranking.reposted_at,
    final_ranking.rank_position
  from final_ranking
  where final_ranking.rank_position <= v_limit
  order by final_ranking.rank_position asc;
end;
$$;

-- ---------------------------------------------------------------------
-- الصلاحيات: EXECUTE إلى authenticated فقط.
--   PostgreSQL يمنح EXECUTE إلى PUBLIC تلقائياً على الدوال الجديدة، فالسحب
--   من public و anon صريح ومقصود. لا تُمنح أي صلاحية على أي جدول هنا.
-- ---------------------------------------------------------------------
revoke all on function public.get_personalized_feed(integer, integer) from public, anon, authenticated;
grant execute on function public.get_personalized_feed(integer, integer) to authenticated;

-- ---------------------------------------------------------------------
-- تحقق داخل الترحيل: يفشل الترحيل كاملاً إن لم تتحقق شروط الأمان.
--
-- الفحص يستهدف التوقيع الدقيق get_personalized_feed(integer, integer) عبر
-- to_regprocedure، لا كل دالة تحمل الاسم نفسه. لو وُجدت نسخة أخرى بالاسم
-- ذاته بتوقيع مختلف فلن تُحسب هنا، ولن تُخفي خطأً في التوقيع المقصود.
-- ---------------------------------------------------------------------
do $$
declare
  target_function oid := to_regprocedure('public.get_personalized_feed(integer,integer)');
  is_security_definer boolean;
  function_settings text[];
  function_owner oid;
  public_or_anon_execute boolean;
  authenticated_execute boolean;
  unexpected_grantees text;
begin
  if target_function is null then
    raise exception 'public.get_personalized_feed(integer, integer) غير موجودة — راجع تعريفها';
  end if;

  select proc.prosecdef, proc.proconfig, proc.proowner
  into is_security_definer, function_settings, function_owner
  from pg_proc as proc
  where proc.oid = target_function;

  -- (أ) SECURITY INVOKER إلزامياً.
  if is_security_definer then
    raise exception 'public.get_personalized_feed(integer, integer) عُرّفت SECURITY DEFINER — يجب أن تكون SECURITY INVOKER';
  end if;

  -- (ب) search_path فارغ. تُقبل الصيغ التي يخزّنها PostgreSQL للنص الفارغ
  --     (search_path= أو search_path="")، ويُشترط أن تكون القيمة فارغة فعلاً.
  if function_settings is null
     or not exists (
       select 1
       from unnest(function_settings) as setting
       where setting like 'search_path=%'
         and btrim(
               btrim(substr(setting, length('search_path=') + 1)),
               '"'''
             ) = ''
     ) then
    raise exception 'public.get_personalized_feed(integer, integer) بلا search_path = '''' — راجع تعريفها';
  end if;

  -- (ج) لا EXECUTE إلى PUBLIC (grantee = 0) ولا إلى anon.
  select exists (
    select 1
    from aclexplode(coalesce(
      (select proc.proacl from pg_proc as proc where proc.oid = target_function),
      acldefault('f', (select proc.proowner from pg_proc as proc where proc.oid = target_function))
    )) as acl
    where acl.privilege_type = 'EXECUTE'
      and acl.grantee in (0, (select role.oid from pg_roles as role where role.rolname = 'anon'))
  )
  into public_or_anon_execute;

  if public_or_anon_execute then
    raise exception 'public.get_personalized_feed(integer, integer) تُمنح EXECUTE إلى PUBLIC أو anon — يجب أن تكون إلى authenticated فقط';
  end if;

  -- (د) EXECUTE إلى authenticated موجودة فعلاً.
  select exists (
    select 1
    from aclexplode(coalesce(
      (select proc.proacl from pg_proc as proc where proc.oid = target_function),
      acldefault('f', (select proc.proowner from pg_proc as proc where proc.oid = target_function))
    )) as acl
    where acl.privilege_type = 'EXECUTE'
      and acl.grantee = (select role.oid from pg_roles as role where role.rolname = 'authenticated')
  )
  into authenticated_execute;

  if not authenticated_execute then
    raise exception 'public.get_personalized_feed(integer, integer) لا تُمنح EXECUTE إلى authenticated — راجع الصلاحيات';
  end if;

  -- (هـ) لا EXECUTE لأي دور آخر غير مالك الدالة و authenticated.
  --     يشمل ذلك PUBLIC (grantee = 0)، و anon، وأي دور مُنح صراحةً، وأي
  --     صلاحية موروثة سُجّلت في ACL. المالك يُستثنى لأنه يملك EXECUTE
  --     ضمنياً، وليس منحاً إضافياً.
  --     الفحص قراءة فقط: لا يمنح ولا يسحب أي صلاحية، ويُفشل الترحيل كاملاً
  --     إن وُجد دور غير متوقع بدل أن يمرّ صامتاً.
  select string_agg(unexpected.grantee_name, ', ' order by unexpected.grantee_name)
  into unexpected_grantees
  from (
    select distinct coalesce(role.rolname, 'PUBLIC') as grantee_name
    from aclexplode(coalesce(
      (select proc.proacl from pg_proc as proc where proc.oid = target_function),
      acldefault('f', function_owner)
    )) as acl
    left join pg_roles as role on role.oid = acl.grantee
    where acl.privilege_type = 'EXECUTE'
      and acl.grantee <> function_owner
      and acl.grantee <> (select role_authenticated.oid from pg_roles as role_authenticated where role_authenticated.rolname = 'authenticated')
  ) as unexpected;

  if unexpected_grantees is not null then
    raise exception
      'public.get_personalized_feed(integer, integer) تُمنح EXECUTE إلى أدوار غير مسموحة: %. المسموح: مالك الدالة و authenticated فقط.',
      unexpected_grantees;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- =====================================================================
-- استعلامات تحقق يدوية بعد المراجعة والموافقة — ليست جزءاً من الترحيل
-- =====================================================================
-- 1) التوقيع والأمان: prosecdef يجب أن يكون false، و proconfig يحتوي
--    search_path فارغاً. الفحص بالتوقيع الدقيق لا بالاسم.
--    select p.proname, p.prosecdef, p.proconfig, p.proacl
--    from pg_proc p
--    where p.oid = to_regprocedure('public.get_personalized_feed(integer,integer)');
--
-- 2) الصلاحيات: المتوقع authenticated فقط
--    select grantee, privilege_type
--    from information_schema.routine_privileges
--    where routine_schema = 'public' and routine_name = 'get_personalized_feed';
--
-- 2ب) لا دور آخر غير المالك و authenticated (المتوقع: صفر صفوف)
--    select coalesce(r.rolname, 'PUBLIC') as grantee
--    from pg_proc p
--    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
--    left join pg_roles r on r.oid = a.grantee
--    where p.oid = to_regprocedure('public.get_personalized_feed(integer,integer)')
--      and a.privilege_type = 'EXECUTE'
--      and a.grantee <> p.proowner
--      and coalesce(r.rolname, '') <> 'authenticated';
--
-- 3) لا صفوف بلا هوية (يُستدعى من جلسة بلا JWT → يجب أن يُعيد صفر صفوف)
--    select * from public.get_personalized_feed(10, 40);
--
-- 4) تفرّد post_id في النتيجة (المتوقع: صفر صفوف مكررة)
--    select post_id, count(*) from public.get_personalized_feed(40, 160)
--    group by post_id having count(*) > 1;
--
-- 5) الترتيب حتمي: تنفيذ الاستدعاء نفسه مرتين متتاليتين يعطي نفس
--    (post_id, rank_position) طالما لم تُنشر منشورات جديدة.
-- =====================================================================

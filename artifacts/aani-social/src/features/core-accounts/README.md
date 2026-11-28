# وحدة الحسابات الأساسية والصلاحية — `src/features/core-accounts`

وحدة مستقلة ومنظمة لإدارة الحسابات الأساسية الثلاثة في تطبيق آني وصلاحياتها، مع جميع ملفاتها مجمعة في مجلد واحد يسهل الرجوع إليه وتعديله وتطويره لاحقًا.

## الحسابات المعتمدة (تُفرض من جانب قاعدة البيانات، لا من العميل)

| البريد | الدور | الغرض | القيود |
|---|---|---|---|
| `anilaw2000@gmail.com` | Founder / Super Admin | الحساب السري الأعلى صلاحية؛ الصلاحيات المالية والتحكم الكامل | لا يُشارك صلاحياته المالية مع أي دور آخر |
| `ani.mohammed2000@gmail.com` | Admin | الإدارة اليومية — المستخدمين، البلاغات، المحتوى، الإشراف | ممنوع من صلاحيات المؤسس المالية ومن تغيير صلاحيات المؤسس |
| `ilawyerm.a.a@gmail.com` | Official | الحساب الرسمي — النشر، الإعلانات، التنبيهات، التواصل الرسمي | لا يمتلك صلاحيات المؤسس أو الإدارة العليا |

**مهم:** البريد الإلكتروني مرجعي للتوثيق فقط. الدور يُحدّد من جانب الخادم عبر جدول الأدوار (ترحيل `aani_core_account_rbac` المطبق على المشروع `auqqqwfjxrxizlmeweka`)، ولا تُستخدم `user_metadata` أو أي قيمة يرسلها المتصفح لتحديد الصلاحية.

## بنية المجلد

```
src/features/core-accounts/
├── README.md                      # هذا الملف
├── index.ts                       # تصدير عام للوحدة
├── types/
│   ├── index.ts
│   ├── account.ts                 # CoreAccount، CoreAccountRole، توثيق الحسابات
│   └── audit.ts                   # أنواع سجل التدقيق
├── roles/
│   ├── index.ts
│   └── definitions.ts             # تعريف الأدوار والصلاحيات (منطق خالص، قابل للاختبار)
├── founder/
│   ├── index.ts
│   ├── guard.ts                   # حراسة صلاحيات المؤسس
│   └── service.ts                 # عمليات المؤسس (تُعيد استخدام sandbox.founders/RPC القائمة)
├── admin/
│   ├── index.ts
│   ├── guard.ts                   # حراسة صلاحيات الإدارة اليومية
│   └── service.ts                 # خدمات الإدارة (عقود خادم قيد الربط)
├── official/
│   ├── index.ts
│   ├── guard.ts                   # حراسة صلاحيات الحساب الرسمي
│   └── service.ts                 # خدمات النشر/الإعلانات (عقود خادم قيد الربط)
├── hooks/
│   ├── index.ts
│   ├── useCoreAccount.ts          # التحقق من الدور والصلاحيات في React
│   └── useFounder.ts              # التحقق من المؤسس المالي عبر sandbox.founders
├── services/
│   ├── index.ts
│   ├── supabase.ts                # وصول عميل Supabase (قابل للحقن)
│   ├── rbac.ts                    # حل الدور عبر RPC خادمي (fail-closed)
│   └── audit.ts                   # سجل التدقيق للعمليات الحساسة
├── components/
│   ├── index.ts
│   ├── RoleGate.tsx               # مكون حماية حسب الدور
│   ├── FounderPanel.tsx           # لوحة مؤسس سرية
│   ├── AdminDashboard.tsx         # لوحة إدارة يومية
│   ├── OfficialComposer.tsx       # واجهة الحساب الرسمي
│   └── CoreAccountNav.tsx         # عنصر تنقل rôles
├── migrations/
│   └── 20261128131724_aani_core_account_rbac.doc.md  # توثيق الترحيل المطبق (لا يُعاد تطبيقه)
└── tests/
    ├── roles.test.ts              # اختبارات منطق الصلاحيات
    └── rbac.contract.test.ts      # اختبارات عقود الخدمات
```

## قواعد الأمان المطبقة
1. التحقق من الصلاحية في الخادم/RPC/Edge Functions — لا يُستخدم إخفاء الأزرار في الواجهة كحماية.
2. لا تُستخدم `user_metadata` أو بيانات قابلة للتعديل من المستخدم لتحديد الصلاحية.
3. `sandbox.founders` يظل مصدر الحقيقة المستقل لصلاحيات المؤسس المالية.
4. Admin وOfficial ممنوعان من أي عملية تمنح صلاحيات المؤسس أو تعدل جدول المؤسسين.
5. تسجيل تدقيق للعمليات الإدارية الحساسة.
6. لا ترحيل مكرر، لا تعديل على الإنتاج، لا تغيير لإعدادات Render/Firebase.

## الربط الفعلي وما بقي غير منفذ

### تم ربطه
- المسارات `/core/founder`، `/core/admin`، `/core/official` في `src/App.tsx` (مست加密 بحارس الدور).
- مكونات اللوحات الثلاث ذاتية الحذر (`RoleGate`) وتستخدم خطاف `useCoreAccount` الذي يستمد الدور من Supabase Auth.
- إعادة استخدام `sandbox.founders` و`aani_sandbox_is_founder` للتحقق المالي للمؤسس بدون تكرار.
- اختبارات وحدة لمنطق الصلاحيات (`tests/roles.test.ts`) وعقود الخدمات.

### بقي غير منفذ (يتطلب عملًا خادمًا منفصلًا)
- إنشاء دالتي RPC `aani_core_account_role` و`aani_core_audit_log` في قاعدة الإنتاج.
- ربط نماذج إنشاء المنشور/الإعلان الفعلية بـ RPC النشر الموجودة.
- إضافة رابط التنقل في `ShellTopBar`/`ShellBottomNav` للأدوار المسموحة (متوفر عبر `CoreAccountNav` جاهز للإدراج).

## الاختبار
```bash
# من جذر المساحة Arbeit
pnpm --filter @workspace/aani-social exec tsx --test ./src/features/core-accounts/tests/roles.test.ts
pnpm --filter @workspace/aani-social exec tsx --test ./src/features/core-accounts/tests/rbac.contract.test.ts
```

## النشر (PR)
تُنشأ الوحدة على فرع مستقل من `main` وترفع ك PR واحد، دون تعديل `main` ولا دمج PR.

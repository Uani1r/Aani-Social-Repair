/**
 * أنواع بيانات وحدة الحسابات الأساسية والصلاحيات (Core Accounts).
 *
 * ملاحظات أمنية إلزامية:
 *  - الدور يُحدّد من جانب الخادم فقط (عبر RPC مؤمّن أو edgebased on auth.uid).
 *  - لا تُستمد الصلاحية من user_metadata ولا من أي قيمة يرسلها المتصفح.
 *  - البريد الإلكتروني الموثّق أدناه هو التكوين الإنتاجي المقصود فقط، ويُفرض
 *    من جانب قاعدة البيانات (ترحيل aani_core_account_rbac المطبق على الإنتاج)،
 *    وليس من这方面 العميل.
 */

export type CoreAccountRole = 'founder' | 'admin' | 'official' | 'user';

export interface CoreAccount {
  /** معرّف المصادقة (auth.users.id / profiles.id) — لا يُعدّل من العميل. */
  id: string;
  /** البريد الموثق في Supabase Auth — مرجعي فقط، ليس مصدرًا للصلاحية. */
  email: string | null;
  role: CoreAccountRole;
  username?: string | null;
  full_name?: string | null;
  /** متى تم تحميل الدور من الخادم آخر مرة. */
  resolvedAt?: string | null;
}

export interface CoreAccountRoleSnapshot {
  id: string;
  role: CoreAccountRole;
  source: 'rpc' | 'cache' | 'none';
}

export const DEFAULT_ACCOUNT: CoreAccount = {
  id: '',
  email: null,
  role: 'user',
};

export const ROOT_ACCOUNT_EMAILS: Record<CoreAccountRole, string> = {
  founder: 'anilaw2000@gmail.com',
  admin: 'ani.mohammed2000@gmail.com',
  official: 'ilawyerm.a.a@gmail.com',
  user: '',
};

/**
 * الحسابات الأساسية المعتمدة في الإنتاج (التكوين المقصود).
 * تُفرض هذه Mapping من جانب قاعدة البيانات؛ العميل يقدّرها للتوثيق فقط
 * ولا يستخدمها कभी في تقرير الدور.
 */
export const CORE_ACCOUNTS_DOCUMENTATION: Array<{
  email: string;
  role: CoreAccountRole;
  purpose: string;
  restrictions: string[];
}> = [
  {
    email: 'anilaw2000@gmail.com',
    role: 'founder',
    purpose: 'المؤسس / المشرف الفائق — الصلاحية المالية العليا والتحكم الكامل.',
    restrictions: [
      'لا يُشارك صلاحياته المالية مع أي دور آخر.',
      'مصدر الحقيقة لصلاحياته المالية هو جدول sandbox.founders فقط.',
    ],
  },
  {
    email: 'ani.mohammed2000@gmail.com',
    role: 'admin',
    purpose: 'حساب الإدارة اليومية — المستخدمين، البلاغات، المحتوى، الإشراف.',
    restrictions: [
      'ممنوع من الوصول إلى صلاحيات المؤسس المالية.',
      'ممنوع من تغيير صلاحيات المؤسس أو جدولة المؤسسين.',
    ],
  },
  {
    email: 'ilawyerm.a.a@gmail.com',
    role: 'official',
    purpose: 'حساب آني الرسمي — النشر، الإعلانات، التنبيهات، التواصل الرسمي.',
    restrictions: [
      'لا يمتلك صلاحيات المؤسس أو الإدارة العليا.',
      'ممنوع من دخول لوحة المؤسس أو لوحة الإدارة.',
    ],
  },
];

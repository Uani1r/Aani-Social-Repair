/**
 * أعمدة profiles العامة وأعمدة التفضيلات الشخصية.
 *
 * منذ ترحيل 20270206000000 لم تُمنح أعمدة التفضيلات الشخصية
 * (notification_settings, appearance_preference, language_preference,
 * hd_uploads, data_saver, font_preference) للقراءة عبر REST لأي مستخدم،
 * حمايةً لخصوصية الآخرين. صاحب الحساب يقرأها عبر الدالة
 * public.aani_my_preferences() التي تُعيد صف auth.uid() وحده.
 *
 * لذلك: أي استعلام على profiles يطلب PUBLIC_PROFILE_COLUMNS فقط، وتُضاف
 * التفضيلات بعد ذلك لملف المستخدم الحالي عبر fetchMyPreferences.
 */

import { supabase, supabaseConfigured } from '@/lib/supabase';
import type { Profile } from '@/lib/types';

/** الأعمدة المتاحة للقراءة لأي مستخدم مسجّل. */
export const PUBLIC_PROFILE_COLUMNS = [
  'id', 'username', 'full_name', 'display_name', 'avatar_url',
  'cover_url', 'cover_position_x', 'cover_position_y',
  'bio', 'website', 'gender',
  'is_private', 'is_nearby_visible', 'is_deactivated',
  'show_city', 'show_job', 'show_birth_date',
  'created_at', 'updated_at',
].join(',');

/**
 * شكل صف profiles عند طلب PUBLIC_PROFILE_COLUMNS.
 * قائمة الأعمدة ديناميكية، فلا يستنتج postgrest-js شكل الصف — يُمرَّر هذا
 * النوع إلى .returns عند الاستعلام. job مستثنى عمداً: قراءته المباشرة مسحوبة
 * ولا تصل إلا عبر aani_public_profile.
 */
export type PublicProfileRow = Omit<Partial<Profile>, 'job'> & Pick<Profile, 'id' | 'username'>;

/**
 * الحقول المشروطة بأعلام الظهور (city/location محكومان بـ show_city،
 * وbirth_date بـ show_birth_date، وjob بـ show_job). لا تُقرأ مباشرة من الجدول:
 * يُعيدها aani_public_profile فارغة عندما يختار صاحب الحساب إخفاءها.
 */
export type ConditionalProfileFields = Pick<Profile, 'city' | 'location' | 'birth_date' | 'job'>;

/**
 * يقرأ حقول الملف المشروطة بأعلام الظهور عبر الدالة المصرّح بها.
 * تُعيد null عند فشل الطلب أو غياب الجلسة، فلا يعرض العميل قيمة مخفية.
 */
export async function fetchConditionalProfileFields(
  userId: string,
): Promise<ConditionalProfileFields | null> {
  if (!supabaseConfigured || !userId) return null;

  try {
    const { data, error } = await supabase.rpc('aani_public_profile', { p_user_id: userId });
    if (error) {
      if (error.code !== '42883' && error.code !== 'PGRST202') {
        console.warn('[profile] تعذر تحميل حقول الملف المشروطة:', error.message);
      }
      return null;
    }

    const row = (Array.isArray(data) ? data[0] : data) as
      | { city?: unknown; location?: unknown; birth_date?: unknown; job?: unknown }
      | null;
    if (!row) return null;

    return {
      city: typeof row.city === 'string' ? row.city : null,
      location: typeof row.location === 'string' ? row.location : null,
      birth_date: typeof row.birth_date === 'string' ? row.birth_date : null,
      job: typeof row.job === 'string' ? row.job : null,
    };
  } catch (error) {
    console.warn('[profile] فشل طلب حقول الملف المشروطة:', error);
    return null;
  }
}

export type MyPreferences = Pick<
  Profile,
  | 'notification_settings'
  | 'appearance_preference'
  | 'language_preference'
  | 'hd_uploads'
  | 'data_saver'
  | 'font_preference'
  | 'is_deactivated'
>;

/**
 * تفضيلات المستخدم الحالي من قاعدة البيانات.
 * تُعيد null عند فشل الطلب أو غياب الجلسة، فيعمل التطبيق على القيم المحلية
 * (fontPreferences / userPreferences) كما كان قبل الترحيل.
 */
export async function fetchMyPreferences(): Promise<MyPreferences | null> {
  if (!supabaseConfigured) return null;

  try {
    const { data, error } = await supabase.rpc('aani_my_preferences');
    if (error) {
      // الدالة غير مثبّتة بعد (42883 / PGRST202) أو الجلسة غابت: لا نُفشل الإقلاع.
      if (error.code !== '42883' && error.code !== 'PGRST202') {
        console.warn('[profile] تعذر تحميل تفضيلات الحساب:', error.message);
      }
      return null;
    }

    const row = (Array.isArray(data) ? data[0] : data) as Partial<MyPreferences> | null;
    if (!row) return null;

    return {
      notification_settings: (row.notification_settings ?? null) as MyPreferences['notification_settings'],
      appearance_preference: (row.appearance_preference ?? null) as MyPreferences['appearance_preference'],
      language_preference: (row.language_preference ?? null) as MyPreferences['language_preference'],
      hd_uploads: typeof row.hd_uploads === 'boolean' ? row.hd_uploads : null,
      data_saver: typeof row.data_saver === 'boolean' ? row.data_saver : null,
      font_preference: (row.font_preference ?? null) as MyPreferences['font_preference'],
      is_deactivated: typeof row.is_deactivated === 'boolean' ? row.is_deactivated : undefined,
    };
  } catch (error) {
    console.warn('[profile] فشل طلب تفضيلات الحساب:', error);
    return null;
  }
}

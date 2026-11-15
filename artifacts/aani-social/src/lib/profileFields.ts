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
  'bio', 'job', 'city', 'location',
  'birth_date', 'show_city', 'show_job', 'show_birth_date', 'website',
  'gender', 'is_private', 'is_nearby_visible', 'is_deactivated',
  'created_at', 'updated_at',
].join(',');

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

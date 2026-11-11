import { supabase } from './supabase';
import type { Profile } from './types';

export const PROFILE_COLUMNS_WITH_GENDER = 'id,username,full_name,display_name,avatar_url,gender,cover_url,cover_position_x,cover_position_y,location,city,job,birth_date,show_city,show_job,show_birth_date,website,bio,is_private,is_deactivated,notification_settings,appearance_preference,language_preference,hd_uploads,data_saver,font_preference,created_at,updated_at';

/**
 * قراءة صف الملف الشخصي مع تحمّل قاعدة بيانات لم يُطبَّق عليها
 * عمود gender بعد (خطأ 42703/PGRST204): يعيد المحاولة بدون العمود،
 * فيُعتبر الجنس null وتستخدم الأيقونة الافتراضية للذكر حتى تطبيق الترحيل.
 */
export async function fetchProfileRow(
  userId: string,
): Promise<{ data: Profile | null; error: { message: string } | null }> {
  const first = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS_WITH_GENDER)
    .eq('id', userId)
    .maybeSingle();

  if (
    first.error
    && (first.error.code === '42703' || first.error.code === 'PGRST204')
    && /gender/i.test(first.error.message || '')
  ) {
    const columns = PROFILE_COLUMNS_WITH_GENDER.replace('gender,', '');
    const retry = await supabase.from('profiles').select(columns).eq('id', userId).maybeSingle();
    return {
      data: (retry.data as Profile | null) ?? null,
      error: retry.error ? { message: retry.error.message } : null,
    };
  }

  return {
    data: (first.data as Profile | null) ?? null,
    error: first.error ? { message: first.error.message } : null,
  };
}

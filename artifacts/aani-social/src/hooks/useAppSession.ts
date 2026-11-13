import { useEffect, useState } from 'react';

import { supabase, supabaseConfigured } from '@/lib/supabase';
import { STORY_VIEWER_PLACEHOLDER_NAMES } from '@/lib/appShared';
import { flushUploadLedgerQueue } from '@/lib/uploadLedgerQueue';
import type { Profile } from '@/lib/types';

export default function useAppSession() {
  const [session, setSession] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  // الحسم الحقيقي لحالة الجلسة: لا تظهر شاشة تسجيل الدخول إلا بعد حسمها
  // (نجاح getSession/فشله الصريح/حدث onAuthStateChange) — مهلة العرض
  // لا تُحوّل حالة المصادقة غير المحسومة إلى "مستخدم غير مسجل".
  const [authResolved, setAuthResolved] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const user = session?.user;

  useEffect(() => {
    if (!supabaseConfigured) {
      setAuthLoading(false);
      setAuthResolved(true);
      return;
    }

    let mounted = true;

    const loadSession = async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        if (mounted) {
          setSession(data.session);
          // سجل الرفع: أي روابط فشل تسجيلها سابقاً تُعاد محاولة تسجيلها الآن
          // (فشلها لا يؤثر على الإقلاع أبداً)
          void flushUploadLedgerQueue().catch(() => undefined);
        }
      } catch (error) {
        console.error('تعذر استعادة جلسة المستخدم:', error);
        if (mounted) setSession(null);
      } finally {
        if (mounted) {
          setAuthLoading(false);
          setAuthResolved(true);
        }
      }
    };

    void loadSession();

    // مهلة عرض شاشة الانتظار فقط: تحرّر حالة التحميل بعد 2500ms كي لا
    // يعلق الإقلاع على استعادة الجلسة، لكنها لا تحسم حالة المصادقة —
    // جلسة تصل لاحقاً (من loadSession أو onAuthStateChange) تُطبَّق
    // طبيعياً والواجهة تنتقل إلى الحالة الصحيحة دون فقدانها.
    const authLoadingGuard = window.setTimeout(() => {
      if (mounted) setAuthLoading(false);
    }, 2500);

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;
      setAuthResolved(true);
      setSession(nextSession);
      setProfile(null);
      if (event === 'SIGNED_IN' && nextSession?.user?.id) {
        // سجل الرفع: إعادة محاولة تسجيل الروابط المعلقة فور توفر جلسة جديدة
        void flushUploadLedgerQueue().catch(() => undefined);
        const signedInUserId = nextSession.user.id;
        window.setTimeout(() => {
          void supabase.from('profiles')
            .update({ is_deactivated: false })
            .eq('id', signedInUserId)
            .eq('is_deactivated', true)
            .then(({ error }) => {
              if (error) console.error('تعذر إعادة تفعيل الحساب عند تسجيل الدخول:', error);
            });
        }, 0);
      }
    });

    return () => {
      mounted = false;
      window.clearTimeout(authLoadingGuard);
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!supabaseConfigured || !user?.id) return;
    let active = true;
    const validName = (value: unknown): string | null => {
      if (typeof value !== 'string') return null;
      const name = value.trim();
      return name && !STORY_VIEWER_PLACEHOLDER_NAMES.has(name.toLowerCase()) ? name : null;
    };
    const metadataName = validName(user.user_metadata?.full_name) || validName(user.user_metadata?.name);

    // ملف بديل من user_metadata فقط — يُستخدم عند فشل طلب profiles أو تعذر
    // معالجة الصف، حتى لا يمنع فشل الملف الشخصي رسم التطبيق.
    const fallbackProfile = (): Profile => ({
      id: user.id,
      username: validName(user.user_metadata?.username) || user.email?.split('@')[0] || 'user',
      full_name: metadataName || validName(user.user_metadata?.username) || user.email?.split('@')[0] || 'مستخدم',
      display_name: metadataName,
      avatar_url: null,
      bio: '',
    });

    const applyProfile = (row: Profile | null) => {
      const username = validName(row?.username) || validName(user.user_metadata?.username) || user.email?.split('@')[0] || 'user';
      const storedDisplayName = validName(row?.display_name);
      setProfile({
        ...(row || {}),
        id: user.id,
        username,
        full_name: validName(row?.full_name) || metadataName || username,
        display_name: storedDisplayName || (row?.display_name ? metadataName : row?.display_name ?? null),
        avatar_url: row?.avatar_url || null,
        bio: row?.bio || '',
      });
    };

    (async () => {
      try {
        const { data, error } = await supabase.from('profiles').select('id,username,full_name,display_name,avatar_url,gender,cover_url,cover_position_x,cover_position_y,location,city,job,birth_date,show_city,show_job,show_birth_date,website,bio,is_private,is_deactivated,is_nearby_visible,notification_settings,appearance_preference,language_preference,hd_uploads,data_saver,font_preference,created_at,updated_at').eq('id', user.id).maybeSingle();
        if (error) throw error;
        if (!active) return;
        applyProfile(data as Profile | null);
      } catch (profileError) {
        // فشل تحميل الملف الشخصي (شبكة/RLS/انقطاع) لا يمنع رسم التطبيق
        console.warn('[app] تعذر تحميل الملف الشخصي — استخدام بيانات الجلسة:', profileError);
        if (!active) return;
        applyProfile(null);
        setProfile(current => current ?? fallbackProfile());
      }
    })();

    return () => {
      active = false;
    };
  }, [user?.id, user?.email, user?.user_metadata?.full_name, user?.user_metadata?.name, user?.user_metadata?.username]);

  const signOut = async () => {
    if (supabaseConfigured) await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
  };

  return { authLoading, authResolved, user, profile, setProfile, signOut };
}

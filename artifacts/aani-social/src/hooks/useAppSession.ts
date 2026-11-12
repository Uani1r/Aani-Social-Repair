import { useEffect, useState } from 'react';

import { supabase, supabaseConfigured } from '@/lib/supabase';
import { STORY_VIEWER_PLACEHOLDER_NAMES } from '@/lib/appShared';
import { flushUploadLedgerQueue } from '@/lib/uploadLedgerQueue';
import type { Profile } from '@/lib/types';

export default function useAppSession() {
  const [session, setSession] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [profile, setProfile] = useState<Profile | null>(null);
  const user = session?.user;

  useEffect(() => {
    if (!supabaseConfigured) {
      setAuthLoading(false);
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
        if (mounted) setAuthLoading(false);
      }
    };

    void loadSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;
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

    void supabase.from('profiles').select('id,username,full_name,display_name,avatar_url,gender,cover_url,cover_position_x,cover_position_y,location,city,job,birth_date,show_city,show_job,show_birth_date,website,bio,is_private,is_deactivated,is_nearby_visible,notification_settings,appearance_preference,language_preference,hd_uploads,data_saver,font_preference,created_at,updated_at').eq('id', user.id).maybeSingle().then(({ data }) => {
      if (!active) return;
      const row = data as Profile | null;
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
    });

    return () => {
      active = false;
    };
  }, [user?.id, user?.email, user?.user_metadata?.full_name, user?.user_metadata?.name, user?.user_metadata?.username]);

  const signOut = async () => {
    if (supabaseConfigured) await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
  };

  return { authLoading, user, profile, setProfile, signOut };
}

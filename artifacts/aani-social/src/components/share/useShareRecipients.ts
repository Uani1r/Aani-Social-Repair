import { useEffect, useState } from 'react';

import { supabase, supabaseConfigured } from '../../lib/supabase';
import { displayName, type Profile } from '../../lib/types';

export function useShareRecipients(currentUserId: string, term: string) {
  const [users, setUsers] = useState<Profile[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);

  useEffect(() => {
    if (!supabaseConfigured) {
      setLoadingUsers(false);
      return;
    }

    let active = true;
    setLoadingUsers(true);

    const timer = window.setTimeout(async () => {
      try {
        const { data: relations, error: relationError } = await supabase
          .from('follows')
          .select('follower_id, following_id')
          .or(`follower_id.eq.${currentUserId},following_id.eq.${currentUserId}`)
          .limit(2000);

        const ids = new Set<string>();
        if (!relationError) {
          (relations || []).forEach((row: { follower_id: string; following_id: string }) => {
            if (row.follower_id === currentUserId) ids.add(row.following_id);
            else if (row.following_id === currentUserId) ids.add(row.follower_id);
          });
        }
        ids.delete(currentUserId);

        if (ids.size === 0) {
          if (active) {
            setUsers([]);
            setLoadingUsers(false);
          }
          return;
        }

        const { data } = await supabase
          .from('profiles')
          .select('id, username, full_name, display_name, avatar_url')
          .in('id', Array.from(ids))
          .limit(500);

        const needle = term.trim().toLowerCase();
        const list = ((data || []) as Profile[]).filter(profile => {
          if (!needle) return true;
          return (
            String(profile.full_name || '').toLowerCase().includes(needle) ||
            String(profile.display_name || '').toLowerCase().includes(needle) ||
            String(profile.username || '').toLowerCase().includes(needle)
          );
        });

        list.sort((a, b) => displayName(a).localeCompare(displayName(b), 'ar'));

        if (active) {
          setUsers(list);
          setLoadingUsers(false);
        }
      } catch (error) {
        console.error('Error loading share recipients:', error);
        if (active) {
          setUsers([]);
          setLoadingUsers(false);
        }
      }
    }, 220);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [term, currentUserId]);

  return { users, loadingUsers };
}

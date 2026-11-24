import { supabase, supabaseConfigured } from '@/lib/supabase';
import type { Profile } from '@/lib/types';

/** صفحة واحدة من الهدايا المستلمة عند العرض في النافذة السفلية. */
export const GIFT_PAGE_SIZE = 20;

export type Gift = {
  id: string;
  name: string;
  /** تكلفة الهدية بعملات المرسل. */
  price: number;
  /** نقاط الشعبية التي تُضاف إلى رصيد المستلم الشعبي عند الاستلام. */
  popularity_points: number;
  image_url: string | null;
  is_active: boolean;
  created_at: string;
};

export type GiftTransaction = {
  id: string;
  gift_id: string;
  sender_id: string;
  recipient_id: string;
  price_paid: number;
  popularity_points: number;
  created_at: string;
};

export type ReceivedGift = GiftTransaction & {
  gift: Pick<Gift, 'id' | 'name' | 'image_url' | 'popularity_points'> | null;
  sender: Pick<
    Profile,
    'id' | 'username' | 'full_name' | 'display_name' | 'avatar_url'
  > | null;
};

export type SendGiftResult = {
  ok: boolean;
  duplicate?: boolean;
  transaction_id?: string;
  balance?: number;
  price_paid?: number;
  popularity_points?: number;
  error?: string;
};

/**
 * تنسيق رقم الشعبية للعرض في الكبسولة والنافذة.
 * الأمثلة المستهدفة: 0 ، 125 ، 1.2K ، 15.8K
 */
export function formatPopularity(value?: number | null): string {
  const n =
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (n < 1000) return String(n);
  const thousands = n / 1000;
  return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, '')}K`;
}

/** إجماليpopularity مستخدم (مستعلم خفيف من دالة RPC آمنة في الخادم). */
export async function fetchPopularity(userId: string): Promise<number | null> {
  if (!supabaseConfigured || !userId) return null;
  const { data, error } = await supabase.rpc('aani_user_popularity', {
    p_user_id: userId,
  });
  if (error) {
    console.warn('[gifts] تعذر جلب الشعبية:', error);
    return null;
  }
  return typeof data === 'number' ? data : 0;
}

/** رصيد العملات الخاص بالمستخدم الحالي (صف المحفظة خاص به عبر RLS). */
export async function fetchMyBalance(userId: string): Promise<number> {
  if (!supabaseConfigured || !userId) return 0;
  const { data, error } = await supabase
    .from('user_wallets')
    .select('balance')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn('[gifts] تعذر جلب الرصيد:', error);
    return 0;
  }
  return typeof data?.balance === 'number' ? data.balance : 0;
}

/** كتالوج الهدايا النشطة للعرض عند اختيار هدية للإرسال. */
export async function fetchGiftCatalog(): Promise<Gift[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('gifts')
    .select('id, name, price, popularity_points, image_url, is_active, created_at')
    .eq('is_active', true)
    .order('price', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) {
    console.warn('[gifts] تعذر جلب كتالوج الهدايا:', error);
    return [];
  }
  return (data ?? []) as Gift[];
}

/**
 * الهدايا المستلمة لمستخدم مع ترحيل (pagination).
 * تُجلب فقط عند فتح النافذة السفلية، وليس عند فتح صفحة الملف الشخصي.
 */
export async function fetchReceivedGifts({
  userId,
  page,
  pageSize = GIFT_PAGE_SIZE,
}: {
  userId: string;
  page: number;
  pageSize?: number;
}): Promise<{ items: ReceivedGift[]; hasMore: boolean }> {
  if (!supabaseConfigured || !userId) return { items: [], hasMore: false };

  const from = page * pageSize;
  // جلب عنصر إضافي لمعرفة وجود صفحة تالية
  const { data, error } = await supabase
    .from('gift_transactions')
    .select(
      'id, gift_id, sender_id, recipient_id, price_paid, popularity_points, created_at'
    )
    .eq('recipient_id', userId)
    .order('created_at', { ascending: false })
    .range(from, from + pageSize);

  if (error) {
    console.warn('[gifts] تعذر جلب الهدايا المستلمة:', error);
    return { items: [], hasMore: false };
  }

  const rows = (data ?? []) as GiftTransaction[];
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, -1) : rows;

  const giftIds = Array.from(new Set(pageRows.map(row => row.gift_id)));
  const senderIds = Array.from(new Set(pageRows.map(row => row.sender_id)));

  const [giftsResult, sendersResult] = await Promise.all([
    giftIds.length
      ? supabase
          .from('gifts')
          .select('id, name, image_url, popularity_points')
          .in('id', giftIds)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    senderIds.length
      ? supabase
          .from('profiles')
          .select('id, username, full_name, display_name, avatar_url')
          .in('id', senderIds)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);

  const giftsById = new Map(
    ((giftsResult.data ?? []) as Gift[]).map(gift => [gift.id, gift])
  );
  const sendersById = new Map(
    ((sendersResult.data ?? []) as Profile[]).map(sender => [sender.id, sender])
  );

  const items: ReceivedGift[] = pageRows.map(row => ({
    ...row,
    gift: giftsById.get(row.gift_id) ?? null,
    sender: sendersById.get(row.sender_id) ?? null,
  }));

  return { items, hasMore };
}

/** إرسال هدية عبر دالة RPC آمنة في الخادم (التحقق من الرصيد والصلاحية والخصم ضمن معاملة واحدة). */
export async function sendGift(
  senderId: string,
  recipientId: string,
  giftId: string
): Promise<SendGiftResult> {
  if (!supabaseConfigured) {
    return { ok: false, error: 'اتصال قاعدة البيانات غير متاح.' };
  }
  const { data, error } = await supabase.rpc('aani_send_gift', {
    p_sender_id: senderId,
    p_recipient_id: recipientId,
    p_gift_id: giftId,
  });
  if (error) {
    return { ok: false, error: error.message || 'فشل إرسال الهدية.' };
  }
  return (data ?? { ok: false }) as SendGiftResult;
}

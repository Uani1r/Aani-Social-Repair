import { supabase } from "./supabase";

/**
 * عدد رسائل المباشر غير المقروءة للمستخدم الحالي.
 *
 * غير المقروء في هذا المشروع = رسالة استلمها المستخدم ولم تُحدَّد قراءتها بعد
 * (عمود read_at لا يزال null — انظر ترحيل 20261204000000_message_delivery_receipts
 * ودالة aani_mark_conversation_read التي يحدث بها MessagesPage القراءة).
 *
 * يعيد null عند فشل الاستعلام ليبقي المتصل على عدّاده السابق بدلاً من تصفيره خطأً.
 */
export const fetchUnreadMessagesCount = async (
  userId: string,
): Promise<number | null> => {
  try {
    const { count, error } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("recipient_id", userId)
      .is("read_at", null);
    if (error) throw error;
    return count ?? 0;
  } catch {
    return null;
  }
};

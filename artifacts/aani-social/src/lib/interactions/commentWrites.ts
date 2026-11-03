import { toast } from "sonner";
import type { Post } from "../types";
import { supabase, supabaseConfigured } from "../supabase";
import { hydratePostIds, normalizeComment } from "./hydration";
import { markPending } from "./store";
import type { PostCommentRow, RawRow } from "./types";

export async function createComment(
  post: Post,
  userId: string,
  content: string,
): Promise<PostCommentRow | null> {
  const trimmed = content.trim();
  if (!trimmed) return null;

  if (!supabaseConfigured || !userId) {
    toast.error("لا يمكن نشر التعليق دون الاتصال بقاعدة البيانات");
    return null;
  }

  markPending(post.id, userId, 1);

  try {
    const { data, error } = await supabase
      .from("comments")
      .insert({ post_id: post.id, user_id: userId, content: trimmed })
      .select("id, post_id, user_id, content, created_at")
      .single();

    if (error || !data) {
      console.error("[comments] تعذر حفظ التعليق:", error);
      toast.error("تعذر نشر التعليق، حاول مرة أخرى");
      return null;
    }

    toast.success("تم نشر التعليق");
    return normalizeComment(data as RawRow);
  } catch (error) {
    console.error("[comments] خطأ أثناء نشر التعليق:", error);
    toast.error("تعذر نشر التعليق، حاول مرة أخرى");
    return null;
  } finally {
    markPending(post.id, userId, -1);
    void hydratePostIds([post.id], userId, { force: true });
  }
}

export async function deleteComment(
  post: Post,
  userId: string,
  commentId: string,
): Promise<boolean> {
  if (!supabaseConfigured || !userId) {
    toast.error("لا يمكن حذف التعليق دون الاتصال بقاعدة البيانات");
    return false;
  }

  markPending(post.id, userId, 1);

  try {
    const { data, error } = await supabase
      .from("comments")
      .delete()
      .eq("id", commentId)
      .eq("user_id", userId)
      .select("id")
      .maybeSingle();

    if (error || !data) {
      toast.error("تعذر حذف التعليق");
      return false;
    }

    toast.success("تم حذف التعليق");
    return true;
  } catch {
    toast.error("تعذر حذف التعليق");
    return false;
  } finally {
    markPending(post.id, userId, -1);
  }
}

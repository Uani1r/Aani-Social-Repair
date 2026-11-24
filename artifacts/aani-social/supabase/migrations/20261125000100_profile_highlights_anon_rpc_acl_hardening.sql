begin;
revoke all on function public.aani_add_profile_highlight(uuid, text, text, text, text, uuid) from public, anon;
grant execute on function public.aani_add_profile_highlight(uuid, text, text, text, text, uuid) to authenticated;
revoke all on function public.aani_can_view_profile_highlight(uuid, boolean) from public, anon;
grant execute on function public.aani_can_view_profile_highlight(uuid, boolean) to authenticated;
revoke all on function public.aani_reorder_profile_content(text, uuid[]) from public, anon;
grant execute on function public.aani_reorder_profile_content(text, uuid[]) to authenticated;
notify pgrst, 'reload schema';
commit;

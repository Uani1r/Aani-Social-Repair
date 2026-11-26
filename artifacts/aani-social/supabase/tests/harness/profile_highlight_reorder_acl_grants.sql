-- Simulates a Supabase project whose ALTER DEFAULT PRIVILEGES hands EXECUTE on
-- new public functions to anon and authenticated. Runs only on the CI
-- PostgreSQL service, between the reordering migration and the ACL correction,
-- so that correction is proven to take the anon grant away.
--
-- The assertion proves the setup took effect: without it the ACL test after the
-- correction would pass on a function that never had anon's grant at all.

grant execute on function public.aani_reorder_profile_highlight_stories(uuid, uuid[])
  to anon, authenticated;

do $$
begin
  if not has_function_privilege('anon', 'public.aani_reorder_profile_highlight_stories(uuid, uuid[])', 'EXECUTE') then
    raise exception 'the simulated Supabase default grant to anon must be in place before the correction';
  end if;

  if not has_function_privilege('authenticated', 'public.aani_reorder_profile_highlight_stories(uuid, uuid[])', 'EXECUTE') then
    raise exception 'the simulated Supabase default grant to authenticated must be in place before the correction';
  end if;
end;
$$;

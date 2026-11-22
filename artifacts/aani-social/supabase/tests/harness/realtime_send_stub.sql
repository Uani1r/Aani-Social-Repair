-- Stand-in for Supabase's realtime.send(jsonb, text, text, boolean), with the
-- same signature the production migration checks for. It records the broadcast
-- in realtime.messages so the trigger test can read it. CI only; never connects
-- to a Supabase project.

begin;

create or replace function realtime.send(payload jsonb, event text, topic text, private boolean)
returns void
language plpgsql
as $$
begin
  insert into realtime.messages (topic, extension, payload, event, private)
  values (topic, 'broadcast', payload, event, private);
end;
$$;

commit;

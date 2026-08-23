-- Push, not poll: let the server hear raw_emails inserts the moment the email
-- worker writes one.
--
-- The worker can already ping /api/ingest/inbound, but only when the server is
-- reachable from the internet — which a laptop behind NAT isn't, so INGEST_URL
-- stayed unset and the pipeline fell back to the INBOX_POLL_SECONDS timer
-- (up to 10 minutes of latency, and a wasted Supabase query every tick when
-- the queue is empty). Realtime inverts the direction: the server holds one
-- outbound websocket to Supabase and gets told about new rows. No tunnel, no
-- inbound port, nothing about the local machine exposed.
--
-- Only the insert matters (a new unprocessed email). The server's own
-- processed_at/error updates are noise, so this publishes inserts alone.

-- Left at the default replica identity on purpose: an INSERT always carries
-- the full new row, so "replica identity full" would buy nothing here and
-- would make every later processed_at/error UPDATE write the whole old row
-- (body_text and all, up to 200k chars) into the WAL.
--
-- Guarded because "alter publication ... add table" is an error, not a no-op,
-- when the table is already a member — which it is on projects whose
-- supabase_realtime publication was created FOR ALL TABLES. This has to be
-- safe to run against both shapes.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'raw_emails'
  ) then
    alter publication supabase_realtime add table public.raw_emails;
  end if;
end
$$;

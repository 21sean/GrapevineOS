-- Extraction attempt budget.
--
-- A row that fails extraction keeps processed_at null so the next kick
-- retries it, which is right for a transient failure (model cold, geocoder
-- rate-limited) and wrong for a poison row the model reliably chokes on:
-- that one is re-selected by every kick forever, spends a full model pass
-- each time, and delays the mail queued behind it.
--
-- Counting attempts lets the server stop after a budget (INBOX_MAX_ATTEMPTS)
-- while keeping the row and its error visible in the admin inbox, where
-- "Reprocess" still forces a retry by hand.
--
-- The existing raw_emails_unprocessed_idx (received_at where processed_at is
-- null) is left alone deliberately. Folding the attempts ceiling into its
-- predicate would hardcode a value that INBOX_MAX_ATTEMPTS can change, and a
-- partial index whose predicate no longer matches the query is simply not
-- used. The queue is small; the existing index is the right one.

alter table public.raw_emails
  add column if not exists attempts smallint not null default 0;

comment on column public.raw_emails.attempts is
  'Failed extraction attempts. Rows at or above INBOX_MAX_ATTEMPTS (default 4) are no longer picked up automatically; reprocess by hand from the admin inbox.';

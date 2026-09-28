-- Extraction engine choice: which LLM runs newsletter extraction and buzz
-- ratings: the local Ollama model (default, fully private) or one of the
-- subscription-authed CLIs (claude / codex / gemini / copilot). Free text
-- like chat_provider; the server coerces unknown values back to 'ollama'.

alter table public.app_settings
  add column extract_provider text not null default 'ollama';

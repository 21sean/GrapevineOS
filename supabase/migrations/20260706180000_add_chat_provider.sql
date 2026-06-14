-- Which engine answers "Ask Grapevine" chats: the local Ollama agent (full
-- LangGraph toolbox) or a subscription-authed CLI (claude / codex / gemini).
alter table public.app_settings
  add column if not exists chat_provider text not null default 'ollama';

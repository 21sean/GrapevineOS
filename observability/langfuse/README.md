# Self-hosted Langfuse

The observability backend for Ask Grapevine: traces of every chat turn
(grouped into sessions by thread id, with the guardrail nodes visible as
spans), plus session scores for rail decisions and conversation-eval
verdicts. Everything stays on this machine.

## Run it

```bash
docker compose up -d
```

- UI: http://localhost:3000 (only langfuse-web and minio are exposed;
  postgres, clickhouse, and redis bind to 127.0.0.1)
- `docker-compose.yml` is the unmodified official file from
  github.com/langfuse/langfuse; every credential and knob rides in `.env`
- `.env` is generated locally and git-ignored. It holds the stack's own
  secrets, the headless-init keys (org, project, API keypair), and the UI
  sign-in (email + password). Losing it is fine: wipe the volumes, write a
  new one, and paste the new keys into `server/.env`

The API server picks the stack up through `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` in `server/.env`. Comment
those out and the integration is fully inert: nothing initializes, nothing
is exported.

## Teardown

```bash
docker compose down        # stop, keep data
docker compose down -v     # stop and delete all trace data
```

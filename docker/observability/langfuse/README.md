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

## Filling it

A fresh stack is empty, and an empty Langfuse teaches nothing about what the
product's observability actually looks like in use. `server/scripts/langfuse/`
populates every tab. Each script is independent, documents its own flags in its
header, and says whether it is re-runnable. Run them in this order the first
time, from `server/`:

```bash
npm run lf:foundation    # model prices, score configs, the prompt library
npm run lf:datasets      # public eval corpora, imported keylessly
npm run lf:evaluators    # Langfuse's official managed judge library
npm run lf:dashboards    # four dashboards of widgets
npm run lf:alerts        # monitors and the webhook automation
npm run lf:traffic       # ~8 weeks of simulated concierge traffic
npm run lf:experiments   # dataset runs over the imported corpora
npm run lf:annotation    # human-review queues drawn from real traces
```

Order matters in three places: traffic needs foundation's prompts and model
prices for its generations to link and cost anything, experiments need the
imported datasets, and annotation needs the traces traffic wrote.

Two standing rules the scripts enforce:

- **Simulated identities only.** Every visitor in Langfuse is a faker persona on
  `example.com` (`scripts/testers.ts`). The operator's real address appears in
  no trace, score, comment or dataset item. OTEL resource auto-detection is off
  everywhere for the same reason: left on, it stamps the host name and OS
  username of the machine onto every span's metadata.
- **No evaluation rule is ACTIVE.** Rules fire at ingest time, on every matching
  observation, against the local Ollama. They are all created disabled so the
  Evaluators tab is furnished without a rule quietly judging traffic on the GPU.
  Enable one deliberately, in the UI, when you want it.

`simulate-traffic.ts` takes `--dry-run`, `--turns N`, `--from` and `--to`, so a
small sample is cheap to look at before writing thousands of spans. It and
`experiments.ts` also take `--reset`, which deletes the spans and scores their
previous run wrote before emitting new ones. Spans get random OTEL ids, so
without `--reset` a second run adds a second copy rather than replacing the
first. Deleting traffic orphans the annotation queues that point at it, so
re-run `lf:annotation` after any `lf:traffic --reset`; its `--reset` finds items
whose trace no longer exists and replaces them.

### Code evaluators

`docker-compose.override.yml` sets `LANGFUSE_CODE_EVAL_DISPATCHER=insecure-local`,
which is what makes the three CODE templates in Langfuse's managed library
(all-caps, exact-match, keyword-match) creatable at all. That dispatcher runs an
evaluator's TypeScript inside the worker process with no sandbox. It is
acceptable here only because this stack is single-user and bound to localhost.
Drop those two lines on any stack that accepts evaluator definitions from
someone else.

## Teardown

```bash
docker compose down        # stop, keep data
docker compose down -v     # stop and delete all trace data
```

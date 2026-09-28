# Contributing

By participating you agree to the [code of conduct](CODE_OF_CONDUCT.md). Bugs
and feature ideas go through the issue forms under `ISSUE_TEMPLATE/`;
security reports go through [SECURITY.md](SECURITY.md), not a public issue.

Grapevine is an npm workspace: `server/` holds the Express API and the agent,
`web/` the Vite client, `shared/` the types and helpers both sides import,
`workers/email-ingest/` the Cloudflare email worker, `supabase/` the schema,
and `docker/observability/` the optional Langfuse and SearXNG stack. One
install at the root covers every package, and one TypeScript, one vitest, one
eslint and one prettier live there too.

## Getting set up

```bash
npm install          # every workspace, one lockfile
npm run doctor       # what is missing, and how to fix it
npm run dev          # api on :8787, web on :5174
```

The ten-minute path in the [README](../README.md) covers the env files;
[docs/setup.md](../docs/setup.md) covers everything optional.

## Scripts

From the root:

| Script                    | Does                                                                 |
| ------------------------- | -------------------------------------------------------------------- |
| `npm run dev`             | API and web app together                                             |
| `npm run build`           | the production web bundle                                            |
| `npm run typecheck`       | `tsc` in every workspace                                             |
| `npm run lint`            | eslint in every workspace                                            |
| `npm test`                | the unit tests in every workspace, no model or database needed       |
| `npm run format`          | prettier over the tree (`format:check` only checks)                  |
| `npm run contracts:check` | the generated skill file matches the contracts                       |
| `npm run evals`           | the eval runner (`-- --suite <name>`, `-- --json`)                   |
| `npm run doctor`          | checks Node, the install, the env files, Supabase, Ollama, the ports |

In `server/` (`npm run <script> -w server`): `db:types` regenerates
`src/db-types.ts` from the linked project, `contracts:gen` rewrites the
OpenClaw skill file, `guardrails:eval` and `guardrails:calibrate` exercise the
classifier, `evals:judge` grades stored conversations, `seed:supabase` loads
the demo sources and settings, `seed:convos` loads demo conversations for the
Monitoring tab, and the `lf:*` scripts seed a running Langfuse
(`docker/observability/langfuse/README.md`). In `workers/email-ingest/`: `dev`,
`test`, `deploy`.

## Opening a pull request

Use the pull request template. Say why the change exists, what moved, and how
you checked it. Conventional prefixes (`feat`, `fix`, `refactor`, `docs`,
`chore`, `build`) stay in the commit messages; the PR title can match.

## Checks before a pull request

CI runs the same commands on every push, in this order:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run contracts:check
npm run evals -- --json --suite personas --suite dedupe --suite recurrence --suite jsonld --suite hours
```

All of it works in a fresh clone with no Ollama and no Supabase; the offline
evals run with placeholder credentials. The model suites, the red team and
the classifier fixtures need a local model and run nightly on a self-hosted
runner (`workflows/nightly.yml`, which only schedules once the repository
variable `GPU_RUNNER` is `true`), or on demand with `npm run evals`.

## Tests and evals

- `server/test/` holds vitest suites for the graph routing, the checkpointer
  (against an in-memory PostgREST fake), the NDJSON bridge (with the graph
  faked), the persona guard, the tool contracts, and the small units (the
  admin gate, secrets, rate limits, the SSRF guard, the LLM policy).
- `web/test/` covers the frame reducer, the NDJSON reader and filter
  normalisation.
- `workers/email-ingest/test/` covers the worker's parsing and dead-letter
  logic.
- `server/src/evals/` is the eval ladder; [docs/agent-architecture.md](../docs/agent-architecture.md)
  explains the tiers. Add an offline case when a change is deterministic and
  a persona case when it changes what a person should be told.

## Adding a tool

Declare it once in `server/src/agent/contracts.ts`, add the executor in
`server/src/agent/tools.ts`, run `npm run contracts:gen`. The recipe with the
details is in [docs/agent-architecture.md](../docs/agent-architecture.md#adding-a-tool).

## Database migrations

`supabase/migrations/` is the schema. The number at the front of each filename
is the version the database records when that file is applied, and the two
must match: `supabase migration list` reports any mismatch as drift, and the
next `db push` refuses to run until it is reconciled.

The rule that keeps them matched is to apply migrations with the Supabase CLI,
so the filename is the version:

```bash
supabase link --project-ref <ref>   # once per clone
supabase db push
```

Do not apply a migration file through the Supabase MCP tool or the dashboard
SQL editor against the linked project. Both record the version as the moment
they ran rather than the filename, and the folder and the database drift
apart. The MCP apply tool is for experiments on a database branch.

After a schema change, regenerate the types the server compiles against:

```bash
npm run db:types -w server
```

## Writing

README and docs use no em dashes and no emojis. Features and architecture come
first, setup and reference later. Code comments say why, not what, and follow
the same punctuation rule. Commit messages follow the conventional prefixes
already in the history (`feat`, `fix`, `refactor`, `docs`, `chore`, `build`)
and explain the reasoning in the body when the diff does not.

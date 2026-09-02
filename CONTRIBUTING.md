# Contributing

Grapevine is a small monorepo: `server/` holds the Express API and the agent,
`web/` the Vite client, `shared/` the types and helpers both sides import,
`workers/email-ingest/` the Cloudflare email worker, `supabase/` the schema,
and `observability/langfuse/` the self-hosted tracing stack. Setup lives in
[docs/setup.md](docs/setup.md).

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
cd server && npm run db:types
```

## Writing

README and docs use no em dashes and no emojis. Features and architecture come
first, setup and reference later.

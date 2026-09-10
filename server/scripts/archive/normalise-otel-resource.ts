/**
 * ARCHIVED 2026-09-02. Not run by any npm script and excluded from typecheck.
 *
 * A one-off repair for spans ingested before OTEL resource auto-detection was
 * turned off everywhere. Every current script and the live server declare their
 * resource by hand, so a fresh stack never produces the rows this rewrites.
 * Kept because the repair was applied once and should stay reproducible.
 */
/**
 * Rewrite the OTEL resource on the traces that were ingested before resource
 * auto-detection was turned off.
 *
 * WHY THIS EXISTS. The first scripts that wrote into this project stood up
 * telemetry with NodeSDK's defaults, and NodeSDK auto-detects its resource:
 * it walks the host and the process and stamps what it finds onto every span.
 * On this machine that produced two bad outcomes. The service-name slot, which
 * the UI shows as the name of the system under observation, was filled with
 * the fallback OTEL uses when nothing declares a service:
 *
 *   unknown_service:C:\Program Files\nodejs\node.exe
 *
 * a local Windows path standing in for a service name. And the resource
 * carried machine metadata onto every span: the host name, the OS user, the
 * script path and its arguments, the CPU architecture, the Node build. This
 * project's rule is that observability data carries synthetic tester
 * identities and nothing about the operator, so none of that belongs there.
 *
 * The generator side is already fixed. otel-bootstrap.ts, foundation.ts,
 * experiments.ts and src/langfuse.ts all build a NodeTracerProvider with an
 * explicit resource instead of letting NodeSDK detect one, so everything
 * emitted from now on is clean and NEW RUNS DO NOT NEED THIS SCRIPT. What is
 * left is the traces that were already ingested: the seed-langfuse.ts
 * backfill, the cost probes, and whatever was written from a live app process
 * before the fix. Re-emitting those is not worth it, so they are normalised in
 * place instead, and this script is what does it, so the repair is repeatable
 * rather than a psql-shaped memory.
 *
 * The identifying keys (host.name, process.owner, process.command,
 * process.command_args, process.executable.*) were stripped in an earlier
 * pass; they are still listed in DROP_KEYS so this file is the whole story and
 * so a re-run after any regression cleans them again.
 *
 * WHAT IT TOUCHES. Both events_core and events_full. In v4 events_only mode
 * events_full is the ingest table and events_core_mv copies each insert across
 * to events_core, but a materialized view only fires on INSERT, so a mutation
 * has to be applied to both tables or the two drift apart and every query
 * disagrees with the one next to it depending on which table it reads.
 *
 * IDEMPOTENT. The predicate matches only rows that still carry an
 * unknown_service name, so a second run reports zero rows and issues nothing.
 * Safe to run at any time; run it AFTER any script that re-emits spans, since
 * re-emitted spans arrive clean and unmatched anyway.
 *
 *   cd server && npx tsx scripts/archive/normalise-otel-resource.ts
 *   flags: --dry-run   report the affected rows and print the SQL, change nothing
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { SERVICE_NAME, SERVICE_VERSION } from "../langfuse/otel-bootstrap.js";

const DRY_RUN = process.argv.includes("--dry-run");

const PROJECT_ID = process.env.LANGFUSE_PROJECT_ID ?? "grapevine-local";
const TABLES = ["events_core", "events_full"];

/**
 * Resource keys that only describe the machine that ran the script. They land
 * in the span's metadata under a resourceAttributes. prefix, and none of them
 * says anything about Grapevine. host.arch and the process.runtime.* trio are
 * what is actually left on the rows today; the rest are the identifying keys
 * NodeSDK also detects, kept here so a regression is cleaned by the same run.
 */
const DROP_KEYS = [
  "resourceAttributes.host.arch",
  "resourceAttributes.host.id",
  "resourceAttributes.host.name",
  "resourceAttributes.process.runtime.name",
  "resourceAttributes.process.runtime.version",
  "resourceAttributes.process.runtime.description",
  "resourceAttributes.process.owner",
  "resourceAttributes.process.pid",
  "resourceAttributes.process.command",
  "resourceAttributes.process.command_args",
  "resourceAttributes.process.executable.name",
  "resourceAttributes.process.executable.path",
];

const OBSERVABILITY_ENV = "../../../docker/observability/langfuse/.env";

/** Read one value out of the docker stack's env file (dotenv does not load it). */
function stackEnv(key: string): string | null {
  try {
    const text = readFileSync(new URL(OBSERVABILITY_ENV, import.meta.url), "utf8");
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : null;
  } catch {
    return null;
  }
}

async function clickhouse(sql: string): Promise<string> {
  const password = process.env.CLICKHOUSE_PASSWORD ?? stackEnv("CLICKHOUSE_PASSWORD");
  if (!password) throw new Error("CLICKHOUSE_PASSWORD not found in the stack env file");
  const res = await fetch(process.env.CLICKHOUSE_HTTP_URL ?? "http://127.0.0.1:8123/", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`clickhouse:${password}`).toString("base64")}`,
    },
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${text.slice(0, 400)}`);
  return text.trim();
}

const quoted = (values: string[]): string => values.map((v) => `'${v}'`).join(", ");

/**
 * Rows whose service name is still OTEL's "nothing declared a service" fallback.
 * Matching on the prefix rather than the exact string keeps this working if the
 * same mistake is ever made from a different machine or a different node path.
 */
const PREDICATE = `project_id = '${PROJECT_ID}' AND startsWith(service_name, 'unknown_service')`;

/**
 * metadata_names and metadata_values are two parallel arrays, not a map, so
 * every edit has to be applied to both in lockstep or the keys and values shear
 * apart. Dropping a key filters both arrays by the same name-based predicate;
 * rewriting the service name maps over the values using the matching name; and
 * the service version, which the clean rows carry and these never had, is
 * appended to the end of both. ALTER UPDATE evaluates every assignment against
 * the ORIGINAL row, so all four expressions can read the unmodified arrays.
 */
function mutationSql(table: string): string {
  const drop = `[${quoted(DROP_KEYS)}]`;
  const keptNames = `arrayFilter((n, v) -> NOT has(${drop}, n), metadata_names, metadata_values)`;
  const keptValues = `arrayFilter((v, n) -> NOT has(${drop}, n), metadata_values, metadata_names)`;
  const versionKey = "resourceAttributes.service.version";
  const needsVersion = `has(metadata_names, '${versionKey}')`;
  const empty = "CAST([], 'Array(String)')";

  return `ALTER TABLE ${table} UPDATE
      service_name = '${SERVICE_NAME}',
      service_version = '${SERVICE_VERSION}',
      metadata_names = arrayConcat(
        ${keptNames},
        if(${needsVersion}, ${empty}, ['${versionKey}'])
      ),
      metadata_values = arrayConcat(
        arrayMap(
          (v, n) -> if(n = 'resourceAttributes.service.name', '${SERVICE_NAME}', v),
          ${keptValues},
          ${keptNames}
        ),
        if(${needsVersion}, ${empty}, ['${SERVICE_VERSION}'])
      )
    WHERE ${PREDICATE}
    SETTINGS mutations_sync = 2`;
}

async function affected(table: string): Promise<number> {
  return Number(await clickhouse(`SELECT count() FROM ${table} WHERE ${PREDICATE} FORMAT TSV`));
}

async function main(): Promise<void> {
  console.log(`normalising the OTEL resource on pre-fix rows${DRY_RUN ? " (dry run)" : ""}\n`);

  for (const table of TABLES) {
    const before = await affected(table);
    if (before === 0) {
      console.log(`  ${table}: nothing to do, no unknown_service rows`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  ${table}: ${before} rows would be rewritten\n${mutationSql(table)}\n`);
      continue;
    }
    // mutations_sync = 2 blocks until every replica has applied the mutation, so
    // the count below is a real check rather than a race against a background job.
    await clickhouse(mutationSql(table));
    console.log(`  ${table}: rewrote ${before} rows, ${await affected(table)} left`);
  }

  if (DRY_RUN) return;

  console.log("\nservice_name across both tables:");
  for (const table of TABLES) {
    const rows = await clickhouse(
      `SELECT service_name, service_version, count()
         FROM ${table} WHERE project_id = '${PROJECT_ID}'
        GROUP BY service_name, service_version ORDER BY count() DESC FORMAT TSV`,
    );
    for (const line of rows.split("\n").filter(Boolean)) console.log(`  ${table}\t${line}`);
  }

  const leftovers = await clickhouse(
    `SELECT arrayJoin(metadata_names) AS k, count()
       FROM events_core WHERE project_id = '${PROJECT_ID}' AND startsWith(k, 'resourceAttributes.')
      GROUP BY k ORDER BY k FORMAT TSV`,
  );
  console.log("\nresource metadata keys remaining in events_core:");
  for (const line of leftovers.split("\n").filter(Boolean)) console.log(`  ${line}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

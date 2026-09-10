/**
 * Fill the Langfuse Alerts tab with the monitors an operator of this system
 * would actually keep switched on, plus a second automation so alert
 * deliveries can be routed by concern instead of all landing on one webhook.
 *
 * Why this script exists at all: monitors and automations have NO public REST
 * API and no MCP create tool in Langfuse v4.27.0. The only writer is tRPC
 * (`monitors.create`, `automations.createAutomation`), both
 * protectedProjectProcedure, both of which reject Langfuse API keys with
 * UNAUTHORIZED. So this script logs in the way the browser does, with a
 * next-auth credentials POST against LANGFUSE_INIT_USER_EMAIL /
 * LANGFUSE_INIT_USER_PASSWORD from docker/observability/langfuse/.env, keeps the
 * session cookie, and speaks superjson-enveloped tRPC. There is a documented
 * direct-Postgres fallback (INSERT INTO monitors with a sha256 scheduler_batch_id
 * fingerprint), but it bypasses the app's own zod validation and is not needed
 * while the login works, so it is deliberately not implemented here.
 *
 * What gets created:
 *   - one WEBHOOK automation, "notify-quality-regressions", alongside the
 *     existing "page-grapevine-server". Both point at the grapevine-bridge
 *     caddy sidecar, because Langfuse only delivers webhooks to ports 80/443
 *     and the Grapevine API listens on 8787. Langfuse mints and encrypts the
 *     webhook secret itself on create, so no secret is handled here.
 *   - eight monitors covering judge quality, the persona and input rails,
 *     graph errors, generation latency, model spend, traffic and the human
 *     review queue. Every threshold is grounded in a number this deployment
 *     actually produces; the reasoning is in the comment above each spec,
 *     because the monitors table has no description column.
 *
 * Safety: monitors are pure ClickHouse aggregations. They never call the LLM,
 * so leaving them ACTIVE costs nothing on the GPU. Their only side effect is a
 * webhook POST to grapevine-bridge -> /api/alerts/langfuse, which console.warns.
 * Two monitors ship PAUSED on purpose (see their specs) so the tab shows both
 * states. Nothing here starts an evaluation rule.
 *
 * Re-runnable: yes. Automations are matched by name and monitors by name
 * before anything is created, so a second run is a no-op that prints "exists".
 * Editing a spec here does NOT update a monitor that already exists; delete it
 * in the UI (or via monitors.delete) and re-run.
 *
 *   cd server && npx tsx scripts/langfuse/alerts.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROJECT_ID = "grapevine-local";
const BASE_URL = (process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

/** The caddy sidecar inside the compose network; see docker-compose.override.yml. */
const BRIDGE_URL = "http://grapevine-bridge/api/alerts/langfuse";
/**
 * The receiver checks this header against INGEST_SHARED_KEY. A header rather
 * than a query string, so the key never lands in caddy's or the server's
 * access log. An automation created before this change still carries the key
 * in its URL: delete it in Langfuse (Automations) and re-run this script.
 */
const BRIDGE_HEADERS = { "X-Ingest-Key": process.env.INGEST_SHARED_KEY ?? "" };

// ---------------------------------------------------------------------------
// Stack credentials. The Langfuse UI login lives with the stack, not with the
// app, and is never printed.
// ---------------------------------------------------------------------------

function stackEnv(key: string): string {
  const path = fileURLToPath(
    new URL("../../../docker/observability/langfuse/.env", import.meta.url),
  );
  const line = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} missing from docker/observability/langfuse/.env`);
  return line.slice(key.length + 1).trim();
}

// ---------------------------------------------------------------------------
// A minimal next-auth session + superjson tRPC client
// ---------------------------------------------------------------------------

const jar = new Map<string, string>();

function absorb(res: Response): void {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Logs in exactly the way the browser does: csrf token, then credentials POST. */
async function signIn(): Promise<void> {
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  absorb(csrfRes);
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

  const body = new URLSearchParams({
    csrfToken,
    email: stackEnv("LANGFUSE_INIT_USER_EMAIL"),
    password: stackEnv("LANGFUSE_INIT_USER_PASSWORD"),
    json: "true",
  });
  const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
    body,
    redirect: "manual",
  });
  absorb(loginRes);

  const session = await trpcQuery<{ count: number }>("monitors.count", { projectId: PROJECT_ID });
  console.log(`[alerts] signed in; project currently has ${session.count} monitor(s)`);
}

function unwrap<T>(payload: unknown, label: string): T {
  const entry = (
    payload as { result?: { data?: { json?: T } }; error?: { json?: { message?: string } } }[]
  )[0];
  if (entry?.error)
    throw new Error(`${label} failed: ${entry.error.json?.message ?? JSON.stringify(entry.error)}`);
  return entry?.result?.data?.json as T;
}

async function trpcQuery<T>(path: string, input: unknown): Promise<T> {
  const encoded = encodeURIComponent(JSON.stringify({ 0: { json: input } }));
  const res = await fetch(`${BASE_URL}/api/trpc/${path}?batch=1&input=${encoded}`, {
    headers: { cookie: cookieHeader() },
  });
  return unwrap<T>(await res.json(), path);
}

async function trpcMutate<T>(path: string, input: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}/api/trpc/${path}?batch=1`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookieHeader() },
    body: JSON.stringify({ 0: { json: input } }),
  });
  return unwrap<T>(await res.json(), path);
}

// ---------------------------------------------------------------------------
// Automations. An automation is a trigger plus an action, and every monitor
// needs at least one, so these must exist before any monitor is created.
// ---------------------------------------------------------------------------

interface Automation {
  id: string;
  name: string;
  trigger: { id: string };
  action: { id: string };
}

async function listAutomations(): Promise<Automation[]> {
  return trpcQuery<Automation[]>("automations.getAutomations", {
    projectId: PROJECT_ID,
    eventSource: "monitor",
  });
}

/**
 * Both automations POST to the same caddy bridge. Splitting them anyway means
 * the quality monitors and the availability monitors have separate delivery
 * histories and separate consecutive-failure counters, which is the whole
 * point of the Automations tab.
 */
async function ensureAutomation(name: string): Promise<string> {
  const existing = (await listAutomations()).find((a) => a.name === name);
  if (existing) {
    console.log(`[alerts] automation ${name} exists (trigger ${existing.trigger.id})`);
    return existing.trigger.id;
  }
  const created = await trpcMutate<{ trigger: { id: string } }>("automations.createAutomation", {
    projectId: PROJECT_ID,
    name,
    eventSource: "monitor",
    eventAction: [],
    filter: [],
    status: "ACTIVE",
    actionType: "WEBHOOK",
    actionConfig: {
      type: "WEBHOOK",
      url: BRIDGE_URL,
      apiVersion: { monitor: "v1" },
      requestHeaders: BRIDGE_HEADERS,
    },
  });
  console.log(`[alerts] created automation ${name} (trigger ${created.trigger.id})`);
  return created.trigger.id;
}

// ---------------------------------------------------------------------------
// Monitors
// ---------------------------------------------------------------------------

type View = "observations" | "scores-numeric" | "scores-categorical" | "scores-boolean";
type Window = "5m" | "10m" | "15m" | "30m" | "1h" | "2h" | "4h" | "1d" | "2d" | "1w";
type NoData =
  | { mode: "SUBSTITUTE_ZERO" }
  | { mode: "LAST_SEVERITY" }
  | { mode: "SHOW_NO_DATA" }
  | { mode: "NOTIFY_NO_DATA"; intervalMinutes: number };
type Renotify = { mode: "OFF" } | { mode: "EVERY"; intervalMinutes: number };

interface MonitorSpec {
  name: string;
  view: View;
  filters: Record<string, unknown>[];
  metric: { measure: string; aggregation: string };
  window: Window;
  thresholdOperator: "GT" | "GTE" | "LT" | "LTE" | "EQ" | "NEQ";
  alertThreshold: number;
  /** Always sent explicitly: the schema types it nullable, not optional. */
  warningThreshold: number | null;
  noData: NoData;
  renotify: Renotify;
  tags: string[];
  status: "ACTIVE" | "PAUSED";
  /** Which automations this monitor notifies, by automation name. */
  routes: string[];
}

const PAGE = "page-grapevine-server";
const QUALITY = "notify-quality-regressions";

/** Score names use the `=` string operator; scores-numeric has no `any of` for name. */
const byScoreName = (name: string) => [
  { type: "string", column: "name", operator: "=", value: name },
];

const SPECS: MonitorSpec[] = [
  // The conversation judge's own verdict bands are: fail below 0.6 or any single
  // metric below 0.5, borderline below 0.75. A whole day averaging under 0.75
  // means the median conversation is borderline, which is a real regression and
  // not one bad thread. Warning at 0.85 is the level the seeded corpus normally
  // sits above. SHOW_NO_DATA because a quiet day is not a quality problem, and
  // SUBSTITUTE_ZERO would read every idle day as a total collapse.
  {
    name: "judge-quality-slipping",
    view: "scores-numeric",
    filters: byScoreName("conversation.overall"),
    metric: { measure: "value", aggregation: "avg" },
    window: "1d",
    thresholdOperator: "LT",
    alertThreshold: 0.75,
    warningThreshold: 0.85,
    noData: { mode: "SHOW_NO_DATA" },
    renotify: { mode: "EVERY", intervalMinutes: 720 },
    tags: ["quality", "judge"],
    status: "ACTIVE",
    routes: [QUALITY],
  },

  // Persona is the one criterion where averaging hides the failure that matters:
  // a single reply that admits to being a language model is a breach even if the
  // other forty replies were perfect. So this takes the MIN over four hours and
  // fires at the judge's own hard-fail line of 0.5, warning at 0.7.
  {
    name: "persona-rail-breach",
    view: "scores-numeric",
    filters: byScoreName("conversation.persona"),
    metric: { measure: "value", aggregation: "min" },
    window: "4h",
    thresholdOperator: "LT",
    alertThreshold: 0.5,
    warningThreshold: 0.7,
    noData: { mode: "SHOW_NO_DATA" },
    renotify: { mode: "OFF" },
    tags: ["guardrails", "persona", "quality"],
    status: "ACTIVE",
    routes: [QUALITY],
  },

  // 0.8 is the deployed input-rail block threshold (settings.guard_threshold,
  // default 0.8 in the guardrail_telemetry migration). p95 above it means more
  // than one message in twenty is being blocked, which is either an attack or a
  // rail that has started misfiring. The 0.6 warning is the top of the measured
  // dead band, where scores stop being confidently benign.
  {
    name: "input-rail-under-pressure",
    view: "scores-numeric",
    filters: byScoreName("rail.input"),
    metric: { measure: "value", aggregation: "p95" },
    window: "1h",
    thresholdOperator: "GT",
    alertThreshold: 0.8,
    warningThreshold: 0.6,
    noData: { mode: "SUBSTITUTE_ZERO" },
    renotify: { mode: "OFF" },
    tags: ["guardrails", "abuse"],
    status: "ACTIVE",
    routes: [QUALITY],
  },

  // The graph logs ERROR spans only when a node actually throws. Two in an hour
  // is a flaky provider worth looking at; five is a broken node. Routed to both
  // automations because this is the one that should page and be logged.
  {
    name: "graph-errors-climbing",
    view: "observations",
    filters: [{ type: "string", column: "level", operator: "=", value: "ERROR" }],
    metric: { measure: "count", aggregation: "count" },
    window: "1h",
    thresholdOperator: "GTE",
    alertThreshold: 5,
    warningThreshold: 2,
    noData: { mode: "SUBSTITUTE_ZERO" },
    renotify: { mode: "OFF" },
    tags: ["reliability", "errors"],
    status: "ACTIVE",
    routes: [PAGE, QUALITY],
  },

  // Measured p95 generation latency on this box is about 36s, because the CLI
  // providers and the 27b ollama model are genuinely slow. The alert therefore
  // sits at 45s (clearly worse than today) and the warning at 30s (just under
  // today, so the tab honestly shows how close the current setup already runs).
  // LAST_SEVERITY on no data: an idle window must not silently clear a
  // regression that was real ten minutes ago.
  {
    name: "concierge-latency-regression",
    view: "observations",
    filters: [{ type: "string", column: "type", operator: "=", value: "GENERATION" }],
    metric: { measure: "latency", aggregation: "p95" },
    window: "4h",
    thresholdOperator: "GT",
    alertThreshold: 45000,
    warningThreshold: 30000,
    noData: { mode: "LAST_SEVERITY" },
    renotify: { mode: "OFF" },
    tags: ["latency", "performance"],
    status: "ACTIVE",
    routes: [PAGE],
  },

  // The concierge is supposed to run entirely on local ollama and CLI providers,
  // where marginal cost is zero; total recorded spend across the whole corpus is
  // under five cents. So any day above 50 cents means traffic quietly fell back
  // to a metered API, and two dollars a day means it has been doing that for
  // hours. This is a leak detector, not a budget.
  {
    name: "daily-model-spend",
    view: "observations",
    filters: [],
    metric: { measure: "totalCost", aggregation: "sum" },
    window: "1d",
    thresholdOperator: "GT",
    alertThreshold: 2,
    warningThreshold: 0.5,
    noData: { mode: "SUBSTITUTE_ZERO" },
    renotify: { mode: "OFF" },
    tags: ["cost", "budget"],
    status: "ACTIVE",
    routes: [PAGE],
  },

  // Tighter companion to the existing 24h tracing-went-quiet monitor: distinct
  // ask-grapevine traces over four hours. PAUSED on purpose. On a single
  // operator's laptop a four hour gap is a lunch break, not an outage, so this
  // would page constantly; it is here configured and ready for the day the app
  // runs continuously, and the 24h monitor stays on as the real alarm.
  {
    name: "concierge-traffic-collapse",
    view: "observations",
    filters: [{ type: "string", column: "traceName", operator: "=", value: "ask-grapevine" }],
    metric: { measure: "traceId", aggregation: "uniq" },
    window: "4h",
    thresholdOperator: "LT",
    alertThreshold: 3,
    warningThreshold: 8,
    noData: { mode: "SUBSTITUTE_ZERO" },
    renotify: { mode: "OFF" },
    tags: ["traffic", "availability"],
    status: "PAUSED",
    routes: [PAGE],
  },

  // The concierge-reply-review queue only produces value when somebody works it:
  // every completed item writes an ANNOTATION-sourced score. Fewer than three in
  // a week means the queue is drifting, fewer than one means nobody has touched
  // it. PAUSED because review here happens in bursts and a quiet week is a
  // scheduling fact, not an incident; it is the metric to switch on once review
  // becomes a standing commitment.
  {
    name: "review-queue-stalled",
    view: "scores-numeric",
    filters: [{ type: "string", column: "source", operator: "=", value: "ANNOTATION" }],
    metric: { measure: "count", aggregation: "count" },
    window: "1w",
    thresholdOperator: "LT",
    alertThreshold: 1,
    warningThreshold: 3,
    noData: { mode: "SUBSTITUTE_ZERO" },
    renotify: { mode: "OFF" },
    tags: ["review", "annotation", "quality"],
    status: "PAUSED",
    routes: [QUALITY],
  },
];

async function listMonitorNames(): Promise<Set<string>> {
  const page = await trpcQuery<{ monitors: { name: string }[] }>("monitors.all", {
    projectId: PROJECT_ID,
    orderBy: null,
    page: 0,
    limit: 100,
  });
  return new Set(page.monitors.map((m) => m.name));
}

async function createMonitors(triggerIdByName: Map<string, string>): Promise<void> {
  const existing = await listMonitorNames();
  for (const spec of SPECS) {
    if (existing.has(spec.name)) {
      console.log(`[alerts] monitor ${spec.name} exists, skipping`);
      continue;
    }
    const { routes, ...rest } = spec;
    const triggerIds = routes.map((name) => {
      const id = triggerIdByName.get(name);
      if (!id) throw new Error(`no trigger for automation ${name}`);
      return id;
    });
    await trpcMutate("monitors.create", { projectId: PROJECT_ID, ...rest, triggerIds });
    console.log(
      `[alerts] created ${spec.name} [${spec.status}] ${spec.view} ` +
        `${spec.metric.aggregation}(${spec.metric.measure}) ${spec.thresholdOperator} ` +
        `${spec.alertThreshold} over ${spec.window} -> ${routes.join(", ")}`,
    );
  }
}

async function main(): Promise<void> {
  await signIn();

  const triggerIdByName = new Map<string, string>();
  for (const automation of await listAutomations()) {
    triggerIdByName.set(automation.name, automation.trigger.id);
  }
  triggerIdByName.set(QUALITY, await ensureAutomation(QUALITY));
  if (!triggerIdByName.has(PAGE)) {
    throw new Error(`expected the existing automation ${PAGE} to be present`);
  }

  await createMonitors(triggerIdByName);

  const after = await listMonitorNames();
  console.log(`[alerts] done. ${after.size} monitors: ${[...after].sort().join(", ")}`);
}

main().catch((err) => {
  console.error("[alerts] failed:", err);
  process.exit(1);
});

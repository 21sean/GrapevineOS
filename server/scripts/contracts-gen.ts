/**
 * Generate the OpenClaw skill file from the tool contracts, so the prose a
 * third-party assistant reads is correct by construction rather than by
 * diligence.
 *
 *   npm run contracts:gen            rewrite openclaw/skills/grapevine/SKILL.md
 *   npm run contracts:gen -- --check exit 1 when the file on disk is stale (CI)
 *
 * Loads contracts.ts and nothing heavier: no database, no graph, no model.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CONTRACTS, toolsFor, type AnyContract } from "../src/agent/contracts.js";
import { INTEREST_TOPICS } from "../src/types.js";

const OUT = fileURLToPath(new URL("../../openclaw/skills/grapevine/SKILL.md", import.meta.url));

// ---------------------------------------------------------------------------
// Schema to prose
// ---------------------------------------------------------------------------

function unwrap(t: z.ZodType): { inner: z.ZodType; optional: boolean } {
  let inner: z.ZodType = t;
  let optional = false;
  for (;;) {
    if (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) {
      optional = true;
      inner = inner.unwrap() as z.ZodType;
    } else if (inner instanceof z.ZodNullable) {
      inner = inner.unwrap() as z.ZodType;
    } else return { inner, optional };
  }
}

function typeName(t: z.ZodType): string {
  if (t instanceof z.ZodString) return "string";
  if (t instanceof z.ZodNumber) return "number";
  if (t instanceof z.ZodBoolean) return "boolean";
  if (t instanceof z.ZodLiteral) return `the literal ${JSON.stringify(t.value)}`;
  if (t instanceof z.ZodEnum) return `one of ${Object.values(t.enum).map((v) => String(v)).join(", ")}`;
  if (t instanceof z.ZodArray) {
    const el = t.element as z.ZodType;
    if (el instanceof z.ZodEnum) return `list from ${Object.values(el.enum).map((v) => String(v)).join(", ")}`;
    return `list of ${typeName(el)}`;
  }
  if (t instanceof z.ZodTuple) return `[${(t.def.items as z.ZodType[]).map(typeName).join(", ")}]`;
  if (t instanceof z.ZodUnion) return (t.def.options as z.ZodType[]).map(typeName).join(" or ");
  return "value";
}

/** Wrap prose at 78 columns so the generated file reads like the hand-written one did. */
function wrap(text: string, width = 78): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function paramTable(c: AnyContract): string {
  const rows = Object.entries(c.schema.shape as Record<string, z.ZodType>).map(([key, field]) => {
    const { inner, optional } = unwrap(field);
    const desc = field.description ?? inner.description ?? "";
    return `| \`${key}\` | ${typeName(inner)} | ${optional ? "optional" : "required"} | ${desc.replace(/\|/g, "\\|")} |`;
  });
  if (!rows.length) return "_No arguments._\n";
  return ["| argument | type | | meaning |", "|---|---|---|---|", ...rows].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// The REST routes each contract answers on
// ---------------------------------------------------------------------------

const ROUTES: Record<string, string> = {
  search_events: "GET /api/ext/v1/events?query=...&categories=music,food&date_from=YYYY-MM-DD",
  get_event: "GET /api/ext/v1/events/:id",
  get_eta: "GET /api/ext/v1/eta?to_event_id=<id>  or  ?to=lng,lat[&from=lng,lat]",
  set_rarity: "POST /api/ext/v1/events/:id/rarity  {\"rarity\": \"rare\"}",
  list_saved_events: "GET /api/ext/v1/calendar",
  save_event: "POST /api/ext/v1/calendar/:eventId",
  unsave_event: "DELETE /api/ext/v1/calendar/:eventId",
  discover_events: "POST /api/ext/v1/discovery/run  {\"query\": \"...\", \"dry_run\": true}",
  list_scheduled_searches: "GET /api/ext/v1/discovery/searches",
  schedule_search: "POST /api/ext/v1/discovery/searches  {\"query\": \"...\", \"cadence_hours\": 24}",
  update_scheduled_search: "PATCH /api/ext/v1/discovery/searches/:id  {\"active\": false}",
  run_scheduled_search: "POST /api/ext/v1/discovery/searches/:id/run",
  unschedule_search: "DELETE /api/ext/v1/discovery/searches/:id",
  update_interests: "POST /api/ext/v1/interests  {\"add_loves\": [\"jazz\"]}",
  apply_interests: "POST /api/ext/v1/interests  {\"add_loves\": [\"jazz\"], \"confirmed\": true}",
};

const ORDER = [
  "search_events",
  "get_event",
  "get_eta",
  "set_rarity",
  "list_saved_events",
  "save_event",
  "unsave_event",
  "discover_events",
  "list_scheduled_searches",
  "schedule_search",
  "update_scheduled_search",
  "run_scheduled_search",
  "unschedule_search",
  "update_interests",
  "apply_interests",
];

function toolSection(c: AnyContract): string {
  const route = ROUTES[c.name];
  if (!route) throw new Error(`contracts-gen: no REST route documented for ${c.name}`);
  const effect =
    c.effect === "read"
      ? "Read-only."
      : c.effect === "propose"
        ? "Proposes only; writes nothing."
        : "Writes to the linked account: confirm with the user first.";
  return [
    `### ${c.name}`,
    "",
    wrap(c.description),
    "",
    "```",
    route,
    "```",
    "",
    paramTable(c),
    effect,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

function render(): string {
  const rest = toolsFor("rest");
  const byName = new Map(rest.map((c) => [c.name, c]));
  const missing = rest.map((c) => c.name).filter((n) => !ORDER.includes(n));
  if (missing.length) throw new Error(`contracts-gen: add to ORDER: ${missing.join(", ")}`);
  const sections = ORDER.map((n) => byName.get(n)).filter((c): c is AnyContract => !!c);
  const mcpNames = toolsFor("mcp").map((c) => c.name);

  return `---
name: grapevine
description: >
  Query the user's local Grapevine server for local events: search what's on
  (tonight, this weekend, by vibe, category or tag), get full event details,
  traffic-aware drive ETAs, and manage the user's saved-events calendar and
  interests. Can also discover NEW events by running a verified web search,
  one-off or on a schedule the server re-runs. Use whenever the user asks
  what's happening locally, wants plans, asks if they can make it to an
  event, wants an event saved, or wants the map topped up from the web.
---

<!-- Generated by server/scripts/contracts-gen.ts from server/src/agent/contracts.ts.
     Edit the contracts or the generator, then \`npm run contracts:gen\`. -->

# Grapevine events

Grapevine is a local-first events map (\`npm run dev\` in its repo). Configure:

- \`GRAPEVINE_URL\`: default \`http://localhost:8787\`
- \`GRAPEVINE_AGENT_KEY\`: must match \`AGENT_API_KEY\` in the server's \`.env\`

Every request needs the header \`X-Agent-Key: $GRAPEVINE_AGENT_KEY\`. Calendar
and interest writes act on the account named by \`AGENT_USER_EMAIL\` in the
server's \`.env\`. Bodies are JSON; GET arguments go in the query string, where
lists are comma-separated and booleans are \`true\` or \`false\`.

Example:

\`\`\`
curl -s "$GRAPEVINE_URL/api/ext/v1/events?query=jazz&date_from=2026-07-10&free_only=true&limit=5" \\
  -H "X-Agent-Key: $GRAPEVINE_AGENT_KEY"
\`\`\`

## Reading the results

\`next_start\` and \`next_end\` are ISO 8601 and reflect the **next occurrence**
for recurring events (\`recurs\` explains the pattern, e.g. "Weekly on Sat");
\`when\` is the same thing human-readable in city time. \`rating\` is 1-5 local
buzz; prefer 3.5 and up. \`promoted: true\` means the source read like a paid
placement; treat it skeptically. Discovery responses separate \`verified\`
(with \`confidence\` and \`evidence\`) from \`rejected\` (with \`reason\`), plus
\`pages_read\` and \`added\`; a discovery run is slow (web search, page reads,
two model passes), expect one to two minutes.

${wrap(`Interest topics are drawn ONLY from: ${INTEREST_TOPICS.join(", ")}. An open Grapevine tab picks changes up on its next page load.`)}

## Tools

${sections.map(toolSection).join("\n")}
## Ground rules

- Only report events the API returned; never invent events, times, or ticket
  links.
- **Confirm with the user before** any write: saving or removing calendar
  entries, applying interests (\`apply_interests\` refuses without
  \`confirmed: true\`), committing discovery results (\`dry_run: false\`), or
  scheduling and deleting a recurring search. Report exactly what changed
  afterwards.
- Discovery results are machine-verified, not gospel: pass the \`evidence\`
  quote and \`source_url\` along so the user can judge, and never present a
  \`rejected\` candidate as a real event.
- Prefer scheduled searches over polling from your side: the server re-runs
  them itself and commits verified events automatically (they appear in the
  app's ingest history as kind "search"). To review what discovery found, read
  the events endpoint with \`date_from\` rather than re-running discovery.
- 400 means the arguments failed validation and the body says which. 401 is
  a key mismatch; 503 means the API is disabled server-side (\`AGENT_API_KEY\`
  or \`AGENT_USER_EMAIL\` unset). If the server is unreachable, say Grapevine
  is not running (\`npm run dev\` in the repo) rather than guessing.

## Prefer MCP when available

The same tools (${mcpNames.join(", ")}) are served over Model Context Protocol
at \`POST $GRAPEVINE_URL/mcp\` (Streamable HTTP). MCP auth is OAuth 2.1
(browser sign-in via the server's consent page) for interactive clients;
headless runtimes send the same key as an \`X-Agent-Key\` header. If your
runtime speaks MCP, connect there instead of shelling out to curl.
`;
}

const rendered = render();
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8").replace(/\r\n/g, "\n");
  } catch {
    /* missing counts as stale */
  }
  if (current !== rendered) {
    console.error(`${OUT} is stale: run npm run contracts:gen and commit the result`);
    process.exit(1);
  }
  console.log(`${OUT} matches the contracts (${Object.keys(CONTRACTS).length} tools)`);
} else {
  writeFileSync(OUT, rendered);
  console.log(`wrote ${OUT} (${toolsFor("rest").length} REST tools, ${toolsFor("mcp").length} MCP tools)`);
}

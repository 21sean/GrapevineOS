# Agent architecture

How "Ask Grapevine" is built, and why each part is the shape it is. Read this
after the [README](../README.md); it goes one level deeper than the README's
architecture section and is the page to open before changing anything under
`server/src/agent/`.

The short version: one LangGraph state graph answers every chat turn. The
guardrails are nodes in that graph, the model behind it is swappable without
touching it, its memory is a durable checkpointer in Postgres, and every tool
it can call is declared once in a contract table that the graph, the MCP
server, the REST API and the generated skill file all derive from.

## The graph

`server/src/agent/graph.ts` builds a `StateGraph` with six nodes:

```
START → input_rail ─ blocked ───────────────────────────────→ END
           │ clean
           ▼          ┌───────── tool_calls ───────┐
        recall        │                            │
           ▼          │                            │
         agent ───────┴─ no tool_calls ────────────┴───────→ END
           ▲                                       │
           │                                       ▼
           └── toolRounds < 6 ─── content_rail ── tools
                                       │ toolRounds = 6
                                       ▼
                                   finalize → END
```

- `input_rail` classifies the user's turn with the local classifier and
  routes: a clean turn is promoted into the transcript and continues, a
  blocked one ends the turn with a refusal and never enters state.
- `recall` folds turns that have scrolled out of the history window (24
  messages) into a running summary, at most once every 8 turns. It is best
  effort: any failure skips the fold and the turn proceeds.
- `agent` calls the model with the toolbox bound. The system prompt (the event
  digest, the clock, the user's interests) is rebuilt every request and never
  persisted, so state holds only the conversation.
- `tools` runs the model's tool calls and streams start and done frames to the
  browser; UI tools also emit action frames from inside the tool.
- `content_rail` scans the untrusted parts of those tool results (web pages,
  search snippets) with the same classifier before the model reads them.
- `finalize` answers without tools once the per-turn budget of six tool
  rounds is spent, so a looping model cannot spin forever.

Routing reads typed state, not message history: `routeAfterAgent` looks for
tool calls on the last message and `routeAfterRail` compares `toolRounds` with
the budget. Both are exported and unit tested.

Node policies apply to the model nodes only. They retry connection failures,
which happen before the first token so a retry cannot duplicate output, and
they fail a stalled generation through an idle timeout that healthy token
streams keep refreshing (about 45 seconds for Ollama, longer for a CLI whose
tool phases are silent). The tools node never retries, because a re-run would
re-emit UI frames, and the rails never retry, because a repeated scan would be
recorded twice.

## State

The state is a LangGraph `StateSchema` in plain Zod 4:

| Channel                 | Reducer         | Meaning                                                               |
| ----------------------- | --------------- | --------------------------------------------------------------------- |
| `messages`              | `MessagesValue` | The transcript. A message with an existing id replaces it.            |
| `toolRounds`            | counter         | Incremented by `tools`; each user turn resets it with `Overwrite(0)`. |
| `summary`, `summarized` | last write      | The recall summary and how many messages it covers.                   |
| `inputBlocked`          | last write      | The input rail refused this turn.                                     |
| `outputTripped`         | last write      | The persona rail replaced the answer.                                 |

Two details keep untrusted text out of durable state. The user's message
reaches the input rail through a closure (`deps.userText`), not a state
channel, so a flagged message is never written by the checkpointer even for
one superstep. Tool results do land in `messages` for one superstep before the
content rail rewrites them in place, which is acceptable because the rail runs
before the `agent` node reads them and tool output is per-turn scratch rather
than the history later turns replay.

## Memory: the checkpointer

Conversation memory is a LangGraph checkpointer keyed by `thread_id`. The
browser sends only the new message; the graph replays the rest. The saver is
`SupabaseSaver` in `server/src/checkpointer.ts`, and it writes through
PostgREST rather than a Postgres connection because this deployment has no
database password: everything the server does goes through supabase-js with
the secret key, and the checkpointer follows the same rule. That is the reason
it looks different from the Postgres saver LangGraph ships, not a quirk.

- Two tables: `chat_checkpoints` and `chat_checkpoint_writes`, keyed the way
  LangGraph keys them (thread, namespace, checkpoint id, and task id plus index
  for writes).
- Each thread is pruned to its newest twelve checkpoints as it grows, every
  eighth write, and a nightly sweep deletes checkpoints older than
  `CHAT_CHECKPOINT_RETENTION_DAYS`.
- When the database does not answer, the saver degrades to no memory for that
  turn and the chat keeps working. The unit tests cover this against an
  in-memory PostgREST fake.
- `chat_messages` is the transcript a person reads in the history panel. The
  checkpointer is the memory the graph uses. There is no third copy and no
  reseed path between them.

## The three rails

| Rail           | Where                | Engine                                  | Fails  |
| -------------- | -------------------- | --------------------------------------- | ------ |
| input          | `input_rail` node    | Llama Prompt Guard 2 (86M, ONNX, CPU)   | open   |
| content        | `content_rail` node  | same classifier, over tool results      | open   |
| output persona | inside `invokeModel` | deterministic patterns with a hold-back | closed |

The classifier rails fail open on purpose: a missing download or a runtime
error logs once and chat continues unscreened, and `GET
/api/agent/capabilities` reports the classifier as `failing-open` so the
state is never invisible. The persona rail is not a node. Every model call the
graph makes streams through it, a trip aborts the model mid-stream, and the
refusal that replaces the answer is what the graph records. Every consumer of
the graph (the chat bridge, the red-team bridge, a test) therefore gets the
same output rail without applying it by hand.

Every rail decision is recorded in `guardrail_scans` and shown in Admin →
Monitoring. The blocking threshold is 0.8 and stays there: the measured score
distribution is bimodal with a dead band between roughly 0.06 and 0.6, so the
threshold is not a lever worth tuning. Coverage is the lever, and it belongs
to the persona rail and the judged suites.

## One graph, every provider

The `agent` and `finalize` nodes call whatever `invokeModel` is given. By
default that is `ChatOllama` with the graph toolbox bound. When Admin →
Providers selects a subscription CLI, it is `CliChatModel`
(`server/src/agent/cli-model.ts`), a LangChain chat model that shells out to
Claude Code, Codex, Gemini or Copilot and streams the answer back through the
same graph, so the CLI gets the same rails, the same memory and the same
traces as Ollama.

Tools differ by provider. Ollama models that support tool calling get the
graph toolbox. Claude Code brings its own toolbox by connecting back to this
server's MCP endpoint, so it drives the same executors from inside its own
process. The other CLIs get a text note, built from the contracts at run
time, describing what the server can do. The capabilities endpoint tells the
browser which of these it is looking at.

## The frame protocol

`POST /api/agent/chat` answers with newline-delimited JSON. Each line is an
`AgentFrame` from `shared/types.ts`, and the client reducer in
`web/src/lib/chatReducer.ts` switches over the union exhaustively, so a frame
added on one side is a compile error on the other until it is handled.

| Frame       | Carries                                                      |
| ----------- | ------------------------------------------------------------ |
| `status`    | A label while nothing streams yet.                           |
| `delta`     | Answer text, appended in order.                              |
| `replace`   | The persona rail replaced the partial answer with this text. |
| `tool`      | A tool call started or finished, with a label and a detail.  |
| `action`    | Something for the browser to do or propose (below).          |
| `notice`    | A degraded-mode sentence the person should read.             |
| `guardrail` | A rail acted, machine-readable: which rail, blocked, score.  |
| `usage`     | Token and cost telemetry when the provider reports it.       |
| `done`      | The turn ended; carries the thread id and the trace id.      |
| `error`     | The turn failed.                                             |

Actions are `highlight` (pin events on the map), `setFilters` (reshape the
map, applied with an undo toast), `proposeCalendar`, `proposeWatch` and
`proposeInterests` (cards the person confirms), `calendarSaved`,
`eventPatched` and `eventsRefresh` (the server changed data; refresh locally).

The bridge in `server/src/agent/chat.ts` translates `graph.stream()` into
these frames, persists the finished answer to `chat_messages`, and aborts the
run when the client disconnects. A turn the input rail refused is never
persisted; a persona replacement is persisted as the replacement.

## The contract module

`server/src/agent/contracts.ts` declares every tool once:

```ts
contract({
  name: "get_eta",
  description: "Traffic-aware drive time from an origin to an event.",
  schema: z.object({ event_id: z.string(), from: lngLat }),
  surfaces: ["graph", "mcp", "rest"],
  effect: "read",
  label: (a) => `ETA to ${a.event_id}`,
  detail: (r) => (typeof r.minutes === "number" ? `${r.minutes} min` : undefined),
});
```

- `surfaces` says where the tool is exposed. `toolsFor("graph")` is what the
  graph binds, `toolsFor("mcp")` is what FastMCP publishes with annotations,
  and the REST router parses bodies and query strings with the same schemas.
- `effect` is the human-in-the-loop policy in one word. `read` answers a
  question, `ui` changes what the browser shows, `propose` shows a card the
  person confirms, `write` changes stored data now. It is the same on every
  surface: `update_interests` proposes everywhere, and the write,
  `apply_interests`, demands `confirmed: true` whether the caller is the
  browser, Claude Desktop or a curl script. Discovery is a dry run by default.
- `label` and `detail` are what the chat shows while the call runs and when it
  finishes, so the UI never has to know a tool by name.
- `openclaw/skills/grapevine/SKILL.md` is generated from the table by
  `npm run contracts:gen`, and `npm run contracts:check` fails CI when it is
  stale.

### Adding a tool

1. Add a `contract` entry in `contracts.ts`: name, description, Zod schema,
   surfaces and effect. Reuse `lngLat`, `eventIds` and the category enum so the
   argument shapes stay uniform.
2. Add the executor in `server/src/agent/tools.ts` under the same name. A
   `read` tool returns data. A `ui` or `propose` tool emits an `AgentAction`
   through the writer, which means adding the action to the `AgentAction`
   union in `shared/types.ts` and handling it in `chatReducer.ts` (the
   compiler tells you where).
3. Run `npm run contracts:gen` to refresh the skill file, and
   `npm run contracts:check` to prove it.
4. Add a case to `server/test/contracts.test.ts` if the tool has rules worth
   pinning (a required `confirmed`, a default, a coercion), and an eval case
   to the personas suite if the tool changes what a persona should be told.
5. The MCP server, the REST API and the capabilities popover pick the tool up
   from the table. Nothing else to register.

## The eval ladder

| Tier                | Needs             | Runs                                            | Command                                       |
| ------------------- | ----------------- | ----------------------------------------------- | --------------------------------------------- |
| Unit tests          | nothing           | every push (CI)                                 | `npm test`                                    |
| Offline evals       | nothing           | every push (CI), report uploaded as an artifact | `npm run evals -- --suite personas ...`       |
| Contract check      | nothing           | every push (CI)                                 | `npm run contracts:check`                     |
| Model suites        | Ollama, a GPU     | nightly on a self-hosted runner, or on demand   | `npm run evals`                               |
| Classifier fixtures | the classifier    | on demand                                       | `npm run guardrails:eval -w server`           |
| Threshold sweep     | the classifier    | on demand                                       | `npm run guardrails:calibrate -w server`      |
| Red team            | Python with PyRIT | nightly, or on demand                           | `npm run evals -- --suite guardrails-redteam` |
| Conversation judge  | the judge model   | in-app sweep of idle threads, off by default    | Admin → Monitoring                            |

The unit tests fake the database and the graph, so `npm test` is green in a
fresh clone with no Ollama and no Supabase. The offline suites (personas,
dedupe, recurrence, jsonld, hours) are deterministic and run in CI with
placeholder credentials. The model suites need the local model and live under
`server/src/evals/suites/`; Admin → Monitoring runs them too and keeps their
history.

The multi-turn red team is PyRIT, not hand-written attacks, because the
attacker has to adapt to the refusal it just got. The two threshold sweeps
stay split, one over the fixed corpus and one over live telemetry, and share
only the confusion-matrix arithmetic.

## Observability

With `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` set, every chat turn is a
Langfuse trace: the graph nodes, the rails and the tool calls are spans, turns
are grouped into sessions by thread id, and guardrail decisions and judge
verdicts land as scores. The rail nodes are the reason a blocked turn reads as
a routing decision in the trace rather than an error. Exported text is masked
(emails, phone numbers, addresses) unless `LANGFUSE_MASK=off`. Without keys,
nothing initialises and nothing leaves the machine.

`docker compose --profile observability up -d` starts the vendored Langfuse
stack; `server/scripts/langfuse/` seeds dashboards, evaluators, datasets and
experiments into it with synthetic tester personas so no real inbox is near
the demo data.

## Deliberate non-changes

Decisions made on evidence earlier that this architecture keeps, so a visitor
sees the reasoning rather than assuming an oversight.

- **Confirm cards stay client-side.** LangGraph's `interrupt()` was evaluated
  for the proposal cards and rejected: the optimistic confirm and undo in
  `ProposalCards` is faster and richer than a graph pause plus a model turn
  per confirmation.
- **The classifier threshold stays at 0.8.** The corpus is bimodal with a
  dead band; coverage is the lever, and it belongs to the persona rail and the
  judged suites.
- **Langfuse evaluator rules stay inactive and the auto-judge sweep stays off
  by default.** Both would judge every ingested span on the local GPU.
- **The deepeval postinstall patch stays** until upstream ships a fixed
  `dist/telemetry.js`. It is self-retiring and says so.
- **The checkpointer writes through PostgREST**, because this deployment has
  no database password.
- **The two threshold sweeps stay split** (fixed corpus and live telemetry).
  Only the confusion-matrix arithmetic is shared.

## Where things live

```
server/src/agent/
  graph.ts        the StateGraph, state schema, routing, invokeModel, the persona rail
  contracts.ts    the tool table every surface derives from
  tools.ts        graph executors bound to the "graph" contracts
  chat.ts         the NDJSON bridge behind POST /api/agent/chat
  ext.ts          the external REST API behind /api/ext/v1
  cli-model.ts    CliChatModel: Claude Code, Codex, Gemini, Copilot as a chat model
  guardrails.ts   the classifier rails and their recording
  refusals.ts     the in-character refusals the rails answer with
  context.ts      the system prompt and the event digest
  websearch.ts    SearXNG or DuckDuckGo search, Readability page reads, the SSRF guard
  telemetry.ts    Langfuse spans and scores
server/src/checkpointer.ts   SupabaseSaver
server/src/mcp.ts            the FastMCP server over the "mcp" contracts
server/src/routes/capabilities.ts   GET /api/agent/capabilities
server/test/                 the unit tests and the PostgREST fake
shared/types.ts              AgentFrame, AgentAction, AgentCapabilities
web/src/lib/chatReducer.ts   the frame reducer
web/src/hooks/useAgentChat.ts  the chat hook over the reducer
```

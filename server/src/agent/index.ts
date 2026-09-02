/**
 * HTTP surface for the "Ask Grapevine" agent.
 *
 *  - POST /api/agent/chat — bridges the LangGraph stream onto NDJSON frames
 *    the web client renders live. The client sends { threadId, message,
 *    context }; conversation history lives server-side in the graph's
 *    checkpointer, keyed by threadId.
 *  - /api/ext/v1/* — the same executors behind an X-Agent-Key header for
 *    external assistants (OpenClaw et al.); writes bind to the account named
 *    by AGENT_USER_EMAIL. See openclaw/skills/grapevine/SKILL.md.
 *
 * Frame protocol (one JSON object per line):
 *   {type:"delta", text}                        streamed answer tokens
 *   {type:"tool", name, label, state, detail?}  tool start/done
 *   {type:"action", action}                     map highlight / proposals
 *   {type:"notice", code, message}              degraded-mode explanations
 *   {type:"guardrail", rail, ...}               a rail acted on this turn
 *   {type:"done", threadId} · {type:"error", message}
 */
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { Router, type Request, type Response } from "express";
import { sessionUser } from "../auth.js";
import { removeEventForUser, saveEventForUser } from "../calendar.js";
import {
  clampCadence,
  runDiscovery,
  runSavedSearch,
  validQuery,
  wantsCommit,
} from "../discovery.js";
import { personaGuard, personaRefusalMessage } from "./guardrails.js";
import { langfuseHandler } from "../langfuse.js";
import { modelSupportsTools, ollamaBase } from "../ollama.js";
import { cliSupportsTools, detectProviders, providerInfo } from "../providers.js";
import { rateLimit, singleFlight } from "../rate-limit.js";
import { safeEqual } from "../secrets.js";
import { store } from "../store.js";
import { isChatEffort, type User } from "../types.js";
import {
  boundAgentUser,
  buildCtx,
  coercePos,
  getEta,
  getEvent,
  INTEREST_TOPICS,
  interestPatchEmpty,
  mergeInterests,
  parseInterestPatch,
  parseLngLat,
  searchEvents,
  searchShape,
  setEventRarity,
  type ChatContext,
  type SearchParams,
} from "./context.js";
import { buildAgentGraph, forgetThread, hasCheckpoint, turnInput } from "./graph.js";

export const agent = Router();

const CHAT_DEADLINE_MS = 120_000;
const MAX_MESSAGE_CHARS = 2_000;

type Frame = Record<string, unknown>;

/**
 * Strips <think>…</think> spans from streamed text, holding back partial tags
 * that split across chunk boundaries. Some models emit these even with the
 * thinking flag off.
 */
function thinkStripper(): (chunk: string) => string {
  let inThink = false;
  let pending = "";
  const partialSuffix = (s: string, tag: string): string => {
    for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
      if (s.endsWith(tag.slice(0, n))) return tag.slice(0, n);
    }
    return "";
  };
  return (chunk) => {
    let text = pending + chunk;
    pending = "";
    let out = "";
    while (text) {
      if (inThink) {
        const close = text.indexOf("</think>");
        if (close >= 0) {
          text = text.slice(close + 8);
          inThink = false;
          continue;
        }
        pending = partialSuffix(text, "</think>");
        text = "";
      } else {
        const open = text.indexOf("<think>");
        if (open >= 0) {
          out += text.slice(0, open);
          text = text.slice(open + 7);
          inThink = true;
          continue;
        }
        const tail = partialSuffix(text, "<think>");
        out += text.slice(0, text.length - tail.length);
        pending = tail;
        text = "";
      }
    }
    return out;
  };
}

// A chat turn is the most expensive request the server takes: one turn holds
// the local GPU for its whole duration. So two limits, not one: a per-address
// budget over a minute, and one stream at a time per account (per address when
// signed out). The second is what stops a stuck tab from queueing a second job
// behind its own.
const chatLimit = rateLimit({ name: "chat", windowMs: 60_000, max: 20 });
const chatFlight = singleFlight({
  name: "conversation",
  key: async (req) => (await sessionUser(req).catch(() => null))?.id ?? `ip:${req.ip}`,
});

agent.post("/api/agent/chat", chatLimit, chatFlight, async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  const send = (frame: Frame) => res.write(JSON.stringify(frame) + "\n");
  // A closed tab must not leave the local GPU generating.
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });

  const body = (req.body ?? {}) as {
    threadId?: string;
    message?: string;
    context?: ChatContext;
    /** Claude Code CLI overrides picked from the chat composer. */
    model?: string;
    effort?: string;
  };
  let threadId =
    typeof body.threadId === "string" && /^[\w-]{8,64}$/.test(body.threadId)
      ? body.threadId
      : crypto.randomUUID();
  const done = () => {
    send({ type: "done", threadId });
    res.end();
  };

  try {
    const settings = await store.settings();

    // History is per-account: a threadId that already belongs to a different
    // user (or to anyone, for a signed-out caller) is re-minted, so nobody can
    // resume — or write into — someone else's conversation by guessing an id.
    const user = await sessionUser(req).catch(() => null);
    const threadOwner = await store.chatThreadOwner(threadId).catch(() => null);
    const ownsThread = !!user && threadOwner === user.id;
    if (threadOwner && !ownsThread) threadId = crypto.randomUUID();

    /** Persist the finished exchange for signed-in users (fire-and-forget). */
    const providerLabel =
      settings.chatProvider === "ollama"
        ? settings.model || "ollama"
        : settings.chatProvider;
    const persist = (assistantText: string) => {
      if (!user || !assistantText.trim()) return;
      store
        .appendChatTurn(user.id, threadId, providerLabel, {
          userText: message.slice(0, MAX_MESSAGE_CHARS),
          assistantText: assistantText.trim(),
        })
        .catch((err) => console.error("[chat] persist:", String(err).slice(0, 160)));
    };

    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      send({ type: "error", message: "send a message" });
      return res.end();
    }

    // Every provider goes through the same LangGraph now — the rails, the
    // checkpointer, the persona guard, and the traces are identical whether
    // the model is local Ollama or a subscription CLI (cli-model.ts). What
    // differs per provider is only the pre-flight below.
    const provider =
      settings.chatProvider && settings.chatProvider !== "ollama"
        ? settings.chatProvider
        : null;

    let baseUrl = "http://localhost:11434";
    let toolsOk = false;
    if (provider) {
      const info = providerInfo(provider);
      const status = (await detectProviders()).find((p) => p.id === provider);
      if (!status?.installed) {
        send({
          type: "notice",
          code: "cli-missing",
          message: `${info.name} isn't installed on the server machine (${info.installHint}). Pick another provider in Admin → Providers.`,
        });
        return done();
      }
      if (!status.authed) {
        send({
          type: "notice",
          code: "cli-auth",
          message: `${info.name} isn't signed in. Run: ${info.loginHint} — ${info.loginNote}.`,
        });
        return done();
      }
      toolsOk = cliSupportsTools(provider);
      // Once per conversation, not once per turn — repeated on every reply it
      // was just noise stacked above the answer.
      if (!(await hasCheckpoint(threadId))) {
        send({
          type: "notice",
          code: "cli-mode",
          message: toolsOk
            ? `${info.name} answers with Grapevine's own MCP tools (event search, details, ETAs, web discovery, calendar saves on the linked account) — live map pinning still needs the local Ollama agent.`
            : `${info.name} answers from the event digest only — map pinning, ETAs, and calendar saves need the local Ollama agent.`,
        });
      }
      send({ type: "status", label: `Asking ${info.name}…` });
    } else {
      if (!settings.model) {
        send({
          type: "notice",
          code: "no-model",
          message: "No model selected. Pick one in Admin → Models.",
        });
        return done();
      }
      baseUrl = await ollamaBase();
      const up = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.ok)
        .catch(() => false);
      if (!up) {
        send({
          type: "notice",
          code: "ollama-down",
          message: `Ollama isn't answering at ${baseUrl}. Start it, then try again.`,
        });
        return done();
      }
      toolsOk = await modelSupportsTools(settings.model);
      if (!toolsOk) {
        send({
          type: "notice",
          code: "no-tools",
          message:
            "This model can't use tools, so answers come from the event digest only. Pick a tools-capable model (e.g. qwen3) in Admin → Models for ETAs and calendar saves.",
        });
      }
    }

    // sessionUser comes from the verified Supabase JWT, never from the wire —
    // overwrite whatever a crafted request may have put in context.
    const chat: ChatContext = { ...(body.context ?? {}), sessionUser: user ?? undefined };
    const ctx = await buildCtx(coercePos(chat.userPos));
    const graph = buildAgentGraph({
      ctx,
      chat,
      baseUrl,
      model: settings.model,
      toolsOk,
      city: settings.city,
      userText: message.slice(0, MAX_MESSAGE_CHARS),
      ...(provider && { provider }),
      ...(provider === "claude" && typeof body.model === "string" && { cliModel: body.model }),
      ...(provider === "claude" && isChatEffort(body.effort) && { cliEffort: body.effort }),
      // Stamped onto every rail decision this turn records, so the panel can
      // slice the distribution by surface and by provider.
      telemetry: {
        surface: provider ? "chat-cli" : "chat",
        threadId,
        userId: user?.id,
        provider: provider ?? settings.model,
      },
    });

    // Server restarts wipe the in-memory checkpointer. When the client resumes
    // a persisted thread it owns, replay the stored transcript into the graph
    // so the conversation keeps its memory across restarts.
    const seed: BaseMessage[] = [];
    if (ownsThread && user && !(await hasCheckpoint(threadId))) {
      for (const m of (await store.chatMessages(user.id, threadId).catch(() => null)) ?? []) {
        seed.push(m.role === "user" ? new HumanMessage(m.content) : new AIMessage(m.content));
      }
    }

    const strip = thinkStripper();
    // Output rail: deterministic persona/identity-leak scrubber over the
    // streamed answer, keyed to whichever model or provider is answering.
    const guard = personaGuard({
      modelName: provider ?? settings.model,
      telemetry: {
        surface: provider ? "chat-cli" : "chat",
        threadId,
        userId: user?.id,
        provider: provider ?? settings.model,
      },
    });
    // With LANGFUSE_* keys set, the turn also lands in Langfuse, grouped into
    // a session by thread id. Null when disabled — no keys, no callbacks.
    const lf = langfuseHandler({ threadId, userId: user?.id, model: providerLabel });
    const stream = await graph.stream(
      // The new user text is NOT in the input: it rides in GraphDeps.userText
      // and only the input_rail node may promote it into state (that is what
      // keeps a flagged message out of the durable checkpointer). turnInput
      // carries any reseeded history and resets the per-turn tool budget.
      turnInput(seed),
      {
        configurable: { thread_id: threadId },
        streamMode: ["messages", "custom"],
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(CHAT_DEADLINE_MS)]),
        recursionLimit: 50,
        runName: "ask-grapevine",
        metadata: { thread_id: threadId, model: providerLabel, tools: toolsOk },
        ...(lf && { callbacks: [lf] }),
      },
    );

    // What the user actually saw, assembled for the persisted history.
    let answer = "";
    // Set when the input rail refuses the turn: its refusal is written by the
    // graph node rather than streamed from the model, and a blocked turn is
    // deliberately kept out of the persisted transcript.
    let railBlocked = false;
    for await (const [mode, chunk] of stream as AsyncIterable<[string, unknown]>) {
      if (mode === "custom") {
        const frame = chunk as Frame;
        if (frame.type === "guardrail" && frame.rail === "input" && frame.blocked) {
          railBlocked = true;
        }
        // The rail nodes emit their refusal as a custom frame, so it has to
        // join `answer` the way a streamed token would — otherwise the reply
        // the user read is not the reply anything downstream sees.
        if (frame.type === "delta" && typeof frame.text === "string") answer += frame.text;
        send(frame);
        continue;
      }
      // mode === "messages": [chunk, metadata] tuples from LLM calls inside nodes
      const [msg, meta] = chunk as [
        { content?: unknown },
        { langgraph_node?: string } | undefined,
      ];
      const node = meta?.langgraph_node;
      if (node !== "agent" && node !== "finalize") continue;
      const raw = typeof msg.content === "string" ? msg.content : "";
      if (!raw) continue;
      const text = guard.push(strip(raw));
      if (guard.tripped) break;
      if (text) {
        answer += text;
        send({ type: "delta", text });
      }
    }
    if (!guard.tripped) {
      const rest = guard.flush();
      if (rest && !guard.tripped) {
        answer += rest;
        send({ type: "delta", text: rest });
      }
    }
    if (guard.tripped) {
      // Stop the local GPU, close out the abandoned stream, and swap the
      // partial reply for an in-character refusal ("replace" frame).
      ac.abort();
      try {
        await (stream as unknown as AsyncGenerator).return?.(undefined);
      } catch {
        /* abort raced the stream teardown */
      }
      send({
        type: "notice",
        code: "guardrails",
        message: "The reply broke character (model identity leak) — replaced by the persona rail.",
      });
      const refusal = personaRefusalMessage(settings.city);
      send({ type: "replace", text: refusal });
      answer = refusal; // history records what the user actually saw
    }
    // A turn the input rail refused stays out of the transcript entirely, so
    // it cannot prime the next one. Everything else is persisted as read.
    if (!railBlocked) persist(answer);
    done();
  } catch (err) {
    if (ac.signal.aborted) {
      try {
        res.end();
      } catch {
        /* connection already gone */
      }
      return;
    }
    const timedOut = /timeout|abort/i.test(String(err));
    send({
      type: "error",
      message: timedOut
        ? "That took too long — try a smaller question or a faster model."
        : String(err).slice(0, 300),
    });
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Chat history — signed-in users only; every route re-checks thread ownership
// against the session, so ids never grant access on their own.
// ---------------------------------------------------------------------------

agent.get("/api/chat/threads", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  try {
    res.json({ threads: await store.chatThreads(user.id) });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

agent.get("/api/chat/threads/:id", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  try {
    const messages = await store.chatMessages(user.id, req.params.id);
    if (!messages) return res.status(404).json({ error: "unknown thread" });
    res.json({ id: req.params.id, messages });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

agent.delete("/api/chat/threads/:id", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  try {
    const deleted = await store.deleteChatThread(user.id, req.params.id);
    if (!deleted) return res.status(404).json({ error: "unknown thread" });
    await forgetThread(req.params.id).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

// ---------------------------------------------------------------------------
// External tools API (OpenClaw and friends) — X-Agent-Key authed.
// Read endpoints mirror the agent's data tools; writes act on the account
// named by AGENT_USER_EMAIL.
// ---------------------------------------------------------------------------

function extAuth(req: Request, res: Response, next: () => void) {
  const key = process.env.AGENT_API_KEY;
  if (!key)
    return res
      .status(503)
      .json({ error: "external agent API disabled: set AGENT_API_KEY in server/.env" });
  if (!safeEqual(req.get("X-Agent-Key"), key)) return res.status(401).json({ error: "bad agent key" });
  next();
}

/** The account external writes act on — bound by env, not by the caller. */
async function extUser(res: Response): Promise<User | null> {
  const user = await boundAgentUser();
  if ("error" in user) {
    res.status(503).json({ error: user.error });
    return null;
  }
  return user;
}

agent.get("/api/ext/v1/events", extAuth, async (req, res) => {
  try {
    const ctx = await buildCtx();
    const q = req.query;
    const str = (k: string) => (typeof q[k] === "string" && q[k] ? String(q[k]) : undefined);
    const num = (k: string) => (str(k) !== undefined ? Number(str(k)) : undefined);
    const bool = (k: string) =>
      str(k) !== undefined ? ["1", "true", "yes"].includes(str(k)!.toLowerCase()) : undefined;
    const result = await searchEvents(
      {
        query: str("q"),
        categories: str("category")?.split(",").map((s) => s.trim()),
        tags: str("tags")?.split(",").map((s) => s.trim()),
        date_from: str("from"),
        date_to: str("to"),
        free_only: bool("free"),
        min_rating: num("min_rating"),
        exclude_promoted: bool("exclude_promoted"),
        near: str("near"),
        max_km: num("max_km"),
        sort: str("sort") as SearchParams["sort"],
        limit: num("limit"),
      },
      ctx,
    );
    res.json({ city: ctx.settings.city, tz: ctx.settings.tz, ...result });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

agent.get("/api/ext/v1/events/:id", extAuth, async (req, res) => {
  try {
    const ctx = await buildCtx();
    const result = getEvent(String(req.params.id), ctx);
    if ("error" in result) return res.status(404).json(result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

/** Correct an event's rarity (drives the app's "Rare finds" filter). */
agent.post("/api/ext/v1/events/:id/rarity", extAuth, async (req, res) => {
  try {
    const ctx = await buildCtx();
    const result = await setEventRarity(req.params.id, req.body?.rarity, ctx);
    if ("error" in result) return res.status(400).json(result);
    res.json({
      id: result.event.id,
      title: result.event.title,
      rarity: result.event.rarity,
      changed: result.changed,
    });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

agent.get("/api/ext/v1/eta", extAuth, async (req, res) => {
  try {
    const ctx = await buildCtx();
    const to = String(req.query.to ?? "");
    const from = typeof req.query.from === "string" ? parseLngLat(req.query.from) : undefined;
    const args = parseLngLat(to) ? { to: parseLngLat(to), from } : { to_event_id: to, from };
    const result = await getEta(args, ctx);
    if ("error" in result) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

agent.get("/api/ext/v1/calendar", extAuth, async (_req, res) => {
  try {
    const user = await extUser(res);
    if (!user) return;
    const ctx = await buildCtx();
    const entries = await store.userCalendar(user.id);
    const events = entries
      .map((entry) => ctx.byId.get(entry.eventId))
      .filter((hit): hit is NonNullable<typeof hit> => !!hit)
      .map(({ e, occ }) => searchShape(e, occ, ctx.settings.tz));
    res.json({ count: events.length, events });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

agent.post("/api/ext/v1/calendar/:eventId", extAuth, async (req, res) => {
  try {
    const user = await extUser(res);
    if (!user) return;
    const result = await saveEventForUser(user, String(req.params.eventId));
    if ("error" in result) return res.status(result.code).json({ error: result.error });
    res.json({ saved: true, ...result });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

agent.delete("/api/ext/v1/calendar/:eventId", extAuth, async (req, res) => {
  try {
    const user = await extUser(res);
    if (!user) return;
    const result = await removeEventForUser(user, String(req.params.eventId));
    if ("error" in result) return res.status(result.code).json({ error: result.error });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ---------- web discovery (search the web → verified events) ----------

/**
 * Run a discovery search now. Body: { query, dry_run? }. Dry runs verify and
 * report without writing — the default on every surface; pass dry_run:false
 * to commit the verified events.
 */
agent.post("/api/ext/v1/discovery/run", extAuth, async (req, res) => {
  const query = validQuery(req.body?.query);
  if (!query) return res.status(400).json({ error: "query must be 3-200 chars" });
  try {
    res.json(await runDiscovery({ query, commit: wantsCommit(req.body) }));
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 300) });
  }
});

agent.get("/api/ext/v1/discovery/searches", extAuth, async (_req, res) => {
  try {
    res.json({ searches: await store.discoverySearches() });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 300) });
  }
});

/** Save a scheduled search: { query, cadence_hours? } (1-336, default 24). */
agent.post("/api/ext/v1/discovery/searches", extAuth, async (req, res) => {
  const query = validQuery(req.body?.query);
  if (!query) return res.status(400).json({ error: "query must be 3-200 chars" });
  try {
    res.json(await store.addDiscoverySearch(query, clampCadence(req.body?.cadence_hours)));
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 300) });
  }
});

/** Pause/resume or re-pace a scheduled search: { active?, cadence_hours? } —
 * same capability the internal API has, so external agents can manage what
 * they create. */
agent.patch("/api/ext/v1/discovery/searches/:id", extAuth, async (req, res) => {
  const patch: { active?: boolean; cadenceHours?: number } = {};
  if (req.body?.active !== undefined) patch.active = Boolean(req.body.active);
  if (req.body?.cadence_hours !== undefined)
    patch.cadenceHours = clampCadence(req.body.cadence_hours);
  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: "nothing to update (active, cadence_hours)" });
  }
  try {
    const updated = await store.updateDiscoverySearch(String(req.params.id), patch);
    if (!updated) return res.status(404).json({ error: "unknown search" });
    res.json(updated);
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 300) });
  }
});

/** Run one saved search immediately (also stamps last_run/status). */
agent.post("/api/ext/v1/discovery/searches/:id/run", extAuth, async (req, res) => {
  try {
    const search = await store.discoverySearchById(String(req.params.id));
    if (!search) return res.status(404).json({ error: "unknown search" });
    res.json(await runSavedSearch(search));
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 300) });
  }
});

agent.delete("/api/ext/v1/discovery/searches/:id", extAuth, async (req, res) => {
  try {
    const deleted = await store.deleteDiscoverySearch(String(req.params.id));
    if (!deleted) return res.status(404).json({ error: "unknown search" });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 300) });
  }
});

agent.post("/api/ext/v1/interests", extAuth, async (req, res) => {
  try {
    const user = await extUser(res);
    if (!user) return;
    const patch = parseInterestPatch(req.body ?? {});
    if (interestPatchEmpty(patch))
      return res
        .status(400)
        .json({ error: `no valid topics — allowed: ${INTEREST_TOPICS.join(", ")}` });

    const current = (user.prefs?.interests ?? {}) as { loves?: string[]; avoids?: string[] };
    const { loves, avoids } = mergeInterests(current, patch);
    const updated = await store.updateUserPrefs(user.id, { interests: { loves, avoids } });
    res.json({
      interests: updated?.prefs?.interests ?? { loves, avoids },
      note: "an open Grapevine tab picks this up on its next page load",
    });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

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
 *   {type:"done", threadId} · {type:"error", message}
 */
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { Router, type Request, type Response } from "express";
import { sessionUser } from "../auth.js";
import { removeEventForUser, saveEventForUser } from "../calendar.js";
import {
  GUARD_MODEL_LABEL,
  inputRefusalMessage,
  personaGuard,
  personaRefusalMessage,
  scanText,
} from "./guardrails.js";
import { modelSupportsTools, ollamaBase } from "../ollama.js";
import {
  buildCliPrompt,
  cliChat,
  cliSupportsTools,
  detectProviders,
  providerInfo,
  pushCliTranscript,
  type CliProviderId,
} from "../providers.js";
import { store } from "../store.js";
import type { User } from "../types.js";
import {
  buildCtx,
  buildSystemPrompt,
  coercePos,
  getEta,
  getEvent,
  INTEREST_TOPICS,
  parseLngLat,
  searchEvents,
  searchShape,
  setEventRarity,
  vetTopics,
  type ChatContext,
  type SearchParams,
} from "./context.js";
import { buildAgentGraph, hasCheckpoint, turnInput } from "./graph.js";

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

agent.post("/api/agent/chat", async (req, res) => {
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

    // Input rail: flagged messages never reach the graph (or its checkpointer,
    // so a blocked turn can't poison the thread history either).
    const verdict = await scanText(message.slice(0, MAX_MESSAGE_CHARS));
    if (verdict.malicious) {
      send({
        type: "notice",
        code: "guardrails",
        message: `Blocked by the local safety classifier (${GUARD_MODEL_LABEL}, score ${verdict.score.toFixed(2)}).`,
      });
      send({ type: "delta", text: inputRefusalMessage(settings.city) });
      return done();
    }

    // Subscription-authed CLI providers (Claude Code / Codex / Gemini CLI)
    // answer digest-only, outside the LangGraph agent.
    if (settings.chatProvider && settings.chatProvider !== "ollama") {
      const answer = await cliChatTurn({
        provider: settings.chatProvider,
        message: message.slice(0, MAX_MESSAGE_CHARS),
        threadId,
        chat: body.context ?? {},
        city: settings.city,
        send,
        signal: ac.signal,
      });
      if (answer) persist(answer);
      return done();
    }

    if (!settings.model) {
      send({
        type: "notice",
        code: "no-model",
        message: "No model selected. Pick one in Admin → Models.",
      });
      return done();
    }
    const baseUrl = await ollamaBase();
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

    const toolsOk = await modelSupportsTools(settings.model);
    if (!toolsOk) {
      send({
        type: "notice",
        code: "no-tools",
        message:
          "This model can't use tools, so answers come from the event digest only. Pick a tools-capable model (e.g. qwen3) in Admin → Models for ETAs and calendar saves.",
      });
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
    // streamed answer, keyed to whichever model the admin has selected.
    const guard = personaGuard({ modelName: settings.model });
    const stream = await graph.stream(
      // turnInput also resets the per-turn tool budget (Overwrite on toolRounds).
      turnInput([...seed, new HumanMessage(message.slice(0, MAX_MESSAGE_CHARS))]),
      {
        configurable: { thread_id: threadId },
        streamMode: ["messages", "custom"],
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(CHAT_DEADLINE_MS)]),
        recursionLimit: 50,
        // With LANGSMITH_TRACING set, runs land in LangSmith named per turn
        // and grouped into conversations by thread_id (the Threads view).
        runName: "ask-grapevine",
        metadata: { thread_id: threadId, model: settings.model, tools: toolsOk },
      },
    );

    // What the user actually saw, assembled for the persisted history.
    let answer = "";
    for await (const [mode, chunk] of stream as AsyncIterable<[string, unknown]>) {
      if (mode === "custom") {
        send(chunk as Frame);
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
    persist(answer);
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
// CLI providers — one shot per turn through claude / codex / gemini, no tools.
// ---------------------------------------------------------------------------

/** Returns the reply as shown to the user (for history), or null when the
 * turn never produced one (provider missing / not signed in). */
async function cliChatTurn(opts: {
  provider: CliProviderId;
  message: string;
  threadId: string;
  chat: ChatContext;
  city: string;
  send: (frame: Frame) => void;
  signal: AbortSignal;
}): Promise<string | null> {
  const { provider, message, threadId, chat, city, send, signal } = opts;
  const info = providerInfo(provider);

  const status = (await detectProviders()).find((p) => p.id === provider);
  if (!status?.installed) {
    send({
      type: "notice",
      code: "cli-missing",
      message: `${info.name} isn't installed on the server machine (${info.installHint}). Pick another provider in Admin → Providers.`,
    });
    return null;
  }
  if (!status.authed) {
    send({
      type: "notice",
      code: "cli-auth",
      message: `${info.name} isn't signed in. Run: ${info.loginHint} — ${info.loginNote}.`,
    });
    return null;
  }

  const withTools = cliSupportsTools(provider);
  send({
    type: "notice",
    code: "cli-mode",
    message: withTools
      ? `${info.name} answers with Grapevine's own MCP tools (event search, details, ETAs, calendar saves on the linked account) — live map pinning still needs the local Ollama agent.`
      : `${info.name} answers from the event digest only — map pinning, ETAs, and calendar saves need the local Ollama agent.`,
  });
  send({ type: "status", label: `Asking ${info.name}…` });

  const ctx = await buildCtx(coercePos(chat.userPos));
  const prompt = buildCliPrompt(buildSystemPrompt(ctx, chat, withTools), threadId, message, {
    tools: withTools,
  });
  const raw = await cliChat(
    provider,
    prompt,
    AbortSignal.any([signal, AbortSignal.timeout(CHAT_DEADLINE_MS)]),
  );

  // Same output rail as the Ollama path — identity leaks never reach the UI.
  const guard = personaGuard({ modelName: provider });
  const text = guard.push(raw) + guard.flush();
  if (guard.tripped) {
    send({
      type: "notice",
      code: "guardrails",
      message: "The reply broke character (model identity leak) — replaced by the persona rail.",
    });
    const refusal = personaRefusalMessage(city);
    send({ type: "delta", text: refusal });
    return refusal;
  }
  send({ type: "delta", text });
  pushCliTranscript(threadId, message, raw);
  return text;
}

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
  if (req.get("X-Agent-Key") !== key) return res.status(401).json({ error: "bad agent key" });
  next();
}

/** The account external writes act on — bound by env, not by the caller. */
async function extUser(res: Response): Promise<User | null> {
  const email = process.env.AGENT_USER_EMAIL;
  if (!email) {
    res.status(503).json({ error: "set AGENT_USER_EMAIL to enable external writes" });
    return null;
  }
  const user = await store.userByEmail(email);
  if (!user) {
    res
      .status(503)
      .json({ error: `no Grapevine account for ${email} — sign in on the web app once first` });
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

agent.post("/api/ext/v1/interests", extAuth, async (req, res) => {
  try {
    const user = await extUser(res);
    if (!user) return;
    const body = req.body ?? {};
    const addLoves = vetTopics(body.addLoves);
    const addAvoids = vetTopics(body.addAvoids);
    const removeLoves = vetTopics(body.removeLoves);
    const removeAvoids = vetTopics(body.removeAvoids);
    if (!addLoves.length && !addAvoids.length && !removeLoves.length && !removeAvoids.length)
      return res
        .status(400)
        .json({ error: `no valid topics — allowed: ${INTEREST_TOPICS.join(", ")}` });

    const current = (user.prefs?.interests ?? {}) as { loves?: string[]; avoids?: string[] };
    // A topic can't be loved and avoided at once — the newer signal wins.
    const loves = [
      ...new Set([
        ...(current.loves ?? []).filter(
          (t) => !removeLoves.includes(t) && !addAvoids.includes(t),
        ),
        ...addLoves,
      ]),
    ];
    const avoids = [
      ...new Set([
        ...(current.avoids ?? []).filter(
          (t) => !removeAvoids.includes(t) && !addLoves.includes(t),
        ),
        ...addAvoids,
      ]),
    ];
    const updated = await store.updateUserPrefs(user.id, { interests: { loves, avoids } });
    res.json({
      interests: updated?.prefs?.interests ?? { loves, avoids },
      note: "an open Grapevine tab picks this up on its next page load",
    });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

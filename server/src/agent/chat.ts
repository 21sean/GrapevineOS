/**
 * The "Ask Grapevine" HTTP bridge: POST /api/agent/chat streams the LangGraph
 * run onto NDJSON frames the web client renders live, and the chat-history
 * routes below it let a signed-in user resume or delete a conversation.
 *
 * The client sends { threadId, message, context }; conversation history
 * lives server-side in the graph's checkpointer, keyed by threadId.
 *
 * The frame protocol is the AgentFrame union in shared/types.ts: one JSON
 * object per line, typed on both ends. In outline:
 *   status     a short label while nothing streams yet ("Thinking…")
 *   delta      streamed answer tokens
 *   replace    the persona rail swapped the partial answer for a refusal
 *   tool       a tool call started or finished
 *   action     a map highlight, filter change, proposal, or refresh
 *   notice     a degraded-mode explanation the person should read
 *   guardrail  a rail acted on this turn (machine-readable)
 *   usage      token and cost telemetry, when the provider reports it
 *   done       the thread id to continue with; error, when it went wrong
 */
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { Router } from "express";
import { sessionUser } from "../auth.js";
import { langfuseHandler } from "../langfuse.js";
import { modelSupportsTools, ollamaBase } from "../ollama.js";
import { cliSupportsTools, detectProviders, providerInfo } from "../providers.js";
import { rateLimit, singleFlight } from "../rate-limit.js";
import { store } from "../store.js";
import { isChatEffort, type AgentFrame } from "../types.js";
import { buildCtx, coercePos, type ChatContext } from "./context.js";
import { buildAgentGraph, forgetThread, hasCheckpoint, turnInput } from "./graph.js";
import { personaGuard, personaRefusalMessage } from "./guardrails.js";

export const chat = Router();

const CHAT_DEADLINE_MS = 120_000;
const MAX_MESSAGE_CHARS = 2_000;

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

chat.post("/api/agent/chat", chatLimit, chatFlight, async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  const send = (frame: AgentFrame) => res.write(JSON.stringify(frame) + "\n");
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
    // resume, or write into, someone else's conversation by guessing an id.
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

    // Every provider goes through the same LangGraph: the rails, the
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
      // Once per conversation, not once per turn: repeated on every reply it
      // was just noise stacked above the answer.
      if (!(await hasCheckpoint(threadId))) {
        send({
          type: "notice",
          code: "cli-mode",
          message: toolsOk
            ? `${info.name} answers with Grapevine's own MCP tools (event search, details, ETAs, web discovery, calendar saves on the linked account); live map pinning still needs the local Ollama agent.`
            : `${info.name} answers from the event digest only; map pinning, ETAs, and calendar saves need the local Ollama agent.`,
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

    // sessionUser comes from the verified Supabase JWT, never from the wire:
    // overwrite whatever a crafted request may have put in context.
    const chatCtx: ChatContext = { ...(body.context ?? {}), sessionUser: user ?? undefined };
    const ctx = await buildCtx(coercePos(chatCtx.userPos));
    const graph = buildAgentGraph({
      ctx,
      chat: chatCtx,
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

    // Threads that predate the durable checkpoint table have no graph state;
    // replay their persisted transcript once so they keep their memory.
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
    // a session by thread id. Null when disabled: no keys, no callbacks.
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
        const frame = chunk as AgentFrame;
        if (frame.type === "guardrail" && frame.rail === "input" && frame.blocked) {
          railBlocked = true;
        }
        // The rail nodes emit their refusal as a custom frame, so it has to
        // join `answer` the way a streamed token would; otherwise the reply
        // the user read is not the reply anything downstream sees.
        if (frame.type === "delta") answer += frame.text;
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
        message: "The reply broke character (model identity leak) and was replaced by the persona rail.",
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
        ? "That took too long. Try a smaller question or a faster model."
        : String(err).slice(0, 300),
    });
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Chat history: signed-in users only; every route re-checks thread ownership
// against the session, so ids never grant access on their own.
// ---------------------------------------------------------------------------

chat.get("/api/chat/threads", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  try {
    res.json({ threads: await store.chatThreads(user.id) });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

chat.get("/api/chat/threads/:id", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  try {
    const id = String(req.params.id);
    const messages = await store.chatMessages(user.id, id);
    if (!messages) return res.status(404).json({ error: "unknown thread" });
    res.json({ id, messages });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

chat.delete("/api/chat/threads/:id", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  try {
    const id = String(req.params.id);
    const deleted = await store.deleteChatThread(user.id, id);
    if (!deleted) return res.status(404).json({ error: "unknown thread" });
    await forgetThread(id).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: String(err).slice(0, 200) });
  }
});

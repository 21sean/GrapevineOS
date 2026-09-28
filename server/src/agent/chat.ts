/**
 * The "Ask Grapevine" HTTP bridge: POST /api/agent/chat streams the LangGraph
 * run onto NDJSON frames the web client renders live, and the chat-history
 * routes below it let a signed-in user resume or delete a conversation.
 *
 * The client sends { threadId, message, context }; conversation history
 * lives server-side in the graph's durable checkpointer, keyed by threadId.
 * There is no second copy to replay from: chat_messages is the human-readable
 * transcript, the checkpointer is the memory.
 *
 * Everything a person sees comes out of the graph as a frame on its custom
 * stream: the model's tokens (already through the persona rail, see
 * graph.ts invokeModel), tool starts and finishes, actions, notices and rail
 * verdicts. This layer adds the pre-flight (which provider, is it up), the
 * limits, the request id, and the persistence of what was read.
 *
 * The frame protocol is the AgentFrame union in shared/types.ts, typed on
 * both ends. In outline:
 *   status     a short label while nothing streams yet ("Thinking…")
 *   delta      streamed answer tokens, cleared by the output rail
 *   replace    the persona rail swapped the partial answer for a refusal
 *   tool       a tool call started or finished
 *   action     a map highlight, filter change, proposal, or refresh
 *   notice     a degraded-mode explanation the person should read
 *   guardrail  a rail acted on this turn (machine-readable)
 *   usage      token and cost telemetry, when the provider reports it
 *   done       the thread id to continue with, and this request's id
 */
import { Router } from "express";
import { sessionUser } from "../auth.js";
import { langfuseHandler } from "../langfuse.js";
import { trackChat } from "../lifecycle.js";
import { logger } from "../log.js";
import { modelSupportsTools, ollamaBase } from "../ollama.js";
import { cliSupportsTools, detectProviders, providerInfo } from "../providers.js";
import { rateLimit, singleFlight } from "../rate-limit.js";
import { currentRequestId } from "../request-id.js";
import { store } from "../store.js";
import { isChatEffort, type AgentFrame } from "../types.js";
import { buildCtx, coercePos, type ChatContext } from "./context.js";
import { buildAgentGraph, forgetThread, hasCheckpoint, turnInput } from "./graph.js";

const log = logger("chat");

export const chat = Router();

const CHAT_DEADLINE_MS = 120_000;
const MAX_MESSAGE_CHARS = 2_000;

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
  const requestId = currentRequestId(res);
  const send = (frame: AgentFrame) => res.write(JSON.stringify(frame) + "\n");
  // A closed tab must not leave the local GPU generating.
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  // A restart tells the tab why the answer stopped, then aborts the run.
  const untrack = trackChat(() => {
    send({
      type: "notice",
      code: "shutdown",
      message: "The server is restarting. Send that again in a moment.",
    });
    ac.abort();
  });
  res.on("close", untrack);

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
    send({ type: "done", threadId, requestId });
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
      settings.chatProvider === "ollama" ? settings.model || "ollama" : settings.chatProvider;
    const persist = (assistantText: string) => {
      if (!user || !assistantText.trim()) return;
      store
        .appendChatTurn(user.id, threadId, providerLabel, {
          userText: message.slice(0, MAX_MESSAGE_CHARS),
          assistantText: assistantText.trim(),
        })
        .catch((err) => log.error({ requestId, err: String(err).slice(0, 160) }, "persist failed"));
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
      settings.chatProvider && settings.chatProvider !== "ollama" ? settings.chatProvider : null;

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
          message: `${info.name} isn't signed in. Run: ${info.loginHint}. Sign in with your ${info.loginNote}.`,
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

    // With LANGFUSE_* keys set, the turn also lands in Langfuse, grouped into
    // a session by thread id and carrying this request's id in its metadata.
    // Null when disabled: no keys, no callbacks.
    const lf = langfuseHandler({ threadId, userId: user?.id, model: providerLabel, requestId });
    const stream = await graph.stream(
      // The new user text is NOT in the input: it rides in GraphDeps.userText
      // and only the input_rail node may promote it into state (that is what
      // keeps a flagged message out of the durable checkpointer). turnInput
      // resets the per-turn tool budget and rail flags.
      turnInput(),
      {
        configurable: { thread_id: threadId },
        streamMode: "custom",
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(CHAT_DEADLINE_MS)]),
        recursionLimit: 50,
        runName: "ask-grapevine",
        metadata: {
          thread_id: threadId,
          model: providerLabel,
          tools: toolsOk,
          request_id: requestId,
        },
        ...(lf && { callbacks: [lf] }),
      },
    );

    // What the user actually saw, assembled for the persisted history. The
    // graph has already run every token through the output rail, so a delta
    // here is safe by construction and a replace is the rail's refusal.
    let answer = "";
    // Set when the input rail refuses the turn: a blocked turn is deliberately
    // kept out of the persisted transcript so it cannot prime the next one.
    let railBlocked = false;
    for await (const frame of stream as AsyncIterable<AgentFrame>) {
      if (frame.type === "guardrail" && frame.rail === "input" && frame.blocked) railBlocked = true;
      if (frame.type === "delta") answer += frame.text;
      if (frame.type === "replace") answer = frame.text;
      send(frame);
    }
    // The client hung up, or the server is stopping, mid-answer: nothing to
    // persist and nobody to answer. A stream that ended cleanly on an abort
    // would otherwise record a half reply as the whole one.
    if (ac.signal.aborted) {
      res.end();
      return;
    }
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
    log.warn({ requestId, threadId, err: String(err).slice(0, 300) }, "chat turn failed");
    send({
      type: "error",
      message: timedOut
        ? "That took too long. Try a smaller question or a faster model."
        : String(err).slice(0, 300),
    });
    res.end();
  } finally {
    untrack();
  }
});

// ---------------------------------------------------------------------------
// Chat history: signed-in users only; every route re-checks thread ownership
// against the session, so ids never grant access on their own.
// ---------------------------------------------------------------------------

chat.get("/api/chat/threads", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  res.json({ threads: await store.chatThreads(user.id) });
});

chat.get("/api/chat/threads/:id", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const id = String(req.params.id);
  const messages = await store.chatMessages(user.id, id);
  if (!messages) return res.status(404).json({ error: "unknown thread" });
  res.json({ id, messages });
});

chat.delete("/api/chat/threads/:id", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const id = String(req.params.id);
  const deleted = await store.deleteChatThread(user.id, id);
  if (!deleted) return res.status(404).json({ error: "unknown thread" });
  await forgetThread(id).catch(() => {});
  res.json({ ok: true });
});

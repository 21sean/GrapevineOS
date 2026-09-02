/**
 * Edge-case suite for the email ingest worker. Runs in plain Node (postal-mime
 * and crypto.subtle are isomorphic) with fetch/KV mocked, so the full email()
 * handler is exercised without a Workers runtime.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  MAX_BODY_CHARS,
  MAX_PARSE_BYTES,
  drainDeadLetters,
  emailKey,
  insertRawEmail,
  sourceSlug,
  stripHtml,
  type Env,
} from "../src/lib";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const PLAIN_EMAIL = [
  "From: SD Today <news@sdtoday.com>",
  "To: sdtoday@example.com",
  "Subject: Weekend events",
  "Message-ID: <abc123@mail.sdtoday.com>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Farmers market Saturday 9am at Little Italy.",
].join("\r\n");

const HTML_EMAIL = [
  "From: news@example.com",
  "To: dostuff@example.com",
  "Subject: Jazz night",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><style>p{color:red}</style><body><h1>Hi &amp; welcome</h1>",
  "<script>alert(1)</script><p>Jazz&nbsp;night &#8212; 8pm &#x2014; free</p></body></html>",
].join("\r\n");

interface FakeMessageInit {
  raw?: unknown;
  rawSize?: number;
  from?: string | null;
  to?: string | null;
  headers?: Record<string, string>;
}

function makeMessage(init: FakeMessageInit = {}) {
  const raw = init.raw ?? PLAIN_EMAIL;
  return {
    from: init.from === undefined ? "news@sdtoday.com" : init.from,
    to: init.to === undefined ? "sdtoday@example.com" : init.to,
    raw,
    rawSize:
      init.rawSize ?? (typeof raw === "string" ? new TextEncoder().encode(raw).length : 1024),
    headers: new Headers(init.headers ?? {}),
    setReject: vi.fn(),
  };
}

function makeEnv(overrides: Partial<Env> & { kvPut?: ReturnType<typeof vi.fn> } = {}) {
  const kvPut = overrides.kvPut ?? vi.fn(async () => {});
  return {
    env: {
      RAW_EMAILS: { put: kvPut } as unknown as Env["RAW_EMAILS"],
      SUPABASE_URL: "https://sb.test",
      SUPABASE_SECRET_KEY: "sk-test",
      ...overrides,
    } as Env,
    kvPut,
  };
}

const PARKED: Record<string, string> = {
  sdtoday_parked1: JSON.stringify({
    to: "sdtoday@example.com",
    from: "news@sdtoday.com",
    subject: "Parked one",
    text: "body",
    receivedAt: "2026-07-31T00:00:00.000Z",
  }),
};

/** Env whose KV behaves like a real dead-letter namespace over `contents`. */
function makeDrainEnv(contents: Record<string, string>, overrides: Partial<Env> = {}) {
  const store = { ...contents };
  const del = vi.fn(async (k: string) => {
    delete store[k];
  });
  const env = {
    RAW_EMAILS: {
      list: async () => ({ keys: Object.keys(store).map((name) => ({ name })) }),
      get: async (k: string) => store[k] ?? null,
      put: vi.fn(async () => {}),
      delete: del,
    } as unknown as Env["RAW_EMAILS"],
    SUPABASE_URL: "https://sb.test",
    SUPABASE_SECRET_KEY: "sk-test",
    ...overrides,
  } as Env;
  return { env, store, del };
}

async function runScheduled(env: Env, ctx?: unknown) {
  const c = (ctx ?? makeCtx().ctx) as { waitUntil: (p: Promise<unknown>) => void };
  const waited: Promise<unknown>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  worker.scheduled!({} as any, env, {
    waitUntil: (p: Promise<unknown>) => {
      waited.push(p);
      c.waitUntil(p);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  await Promise.all(waited);
}

function makeCtx() {
  const waited: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: vi.fn((p: Promise<unknown>) => waited.push(p)) },
    waited,
  };
}

/** Run the handler with a mocked fetch; returns the mock plus captured rows. */
function mockFetch(...responses: Array<Response | Error>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? new Response(null, { status: 201 });
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

function insertedRow(calls: { init: RequestInit }[], index = 0) {
  return JSON.parse(String(calls[index]!.init.body))[0];
}

async function runEmail(message: unknown, env: Env, ctx?: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return worker.email(message as any, env, (ctx ?? makeCtx().ctx) as any);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// sourceSlug — must always satisfy sources.id's ^[a-z0-9][a-z0-9_-]*$ check
// ---------------------------------------------------------------------------

describe("sourceSlug", () => {
  const VALID = /^[a-z0-9][a-z0-9_-]*$/;

  it.each([
    ["sdtoday@example.com", "sdtoday"],
    ["SDToday+promo@Example.Com", "sdtoday"],
    ["John.Doe@example.com", "john-doe"],
    ["weird!!local@x", "weird-local"],
    [".leading@x", "leading"],
    ["___@x", "inbound"],
    ["@x", "inbound"],
    ["", "inbound"],
    ["unknown@unknown", "unknown"],
  ])("%s → %s", (input, expected) => {
    const slug = sourceSlug(input);
    expect(slug).toBe(expected);
    expect(slug).toMatch(VALID);
  });
});

// ---------------------------------------------------------------------------
// stripHtml
// ---------------------------------------------------------------------------

describe("stripHtml", () => {
  it("drops style/script blocks and tags, decodes entities", () => {
    const text = stripHtml(
      "<style>p{}</style><h1>Hi &amp; welcome</h1><script>x()</script>" +
        "<p>Jazz&nbsp;night &#8212; 8pm &#x2014; &rsquo;till late</p>",
    );
    expect(text).toBe("Hi & welcome Jazz night — 8pm — ’till late");
  });

  it("does not double-decode", () => {
    expect(stripHtml("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });

  it("collapses the invisible spacer runs marketing templates pad with", () => {
    const padded = "Welcome!" + "&zwnj; ".repeat(50) + "​​﻿" + "<p>Trivia 7pm</p>";
    expect(stripHtml(padded)).toBe("Welcome! Trivia 7pm");
  });

  it("decodes the extra punctuation entities newsletters use", () => {
    expect(stripHtml("Beer &bull; 8pm &middot; 72&deg; &raquo;")).toBe("Beer • 8pm · 72° »");
  });

  it("leaves unknown entities alone and survives bad code points", () => {
    expect(stripHtml("&bogus; &#99999999999;")).toBe("&bogus;");
  });
});

// ---------------------------------------------------------------------------
// emailKey
// ---------------------------------------------------------------------------

describe("emailKey", () => {
  const payload = {
    to: "a@b",
    from: "c@d",
    subject: "s",
    text: "t",
    receivedAt: "2026-01-01T00:00:00Z",
  };

  it("uses a bracket-stripped Message-ID when present", async () => {
    expect(await emailKey("src", payload, "<id@host>")).toBe("src_id@host");
  });

  it("bounds long Message-IDs", async () => {
    const key = await emailKey("src", payload, `<${"x".repeat(400)}>`);
    expect(key.length).toBeLessThanOrEqual("src_".length + 180);
  });

  it("hashes content when Message-ID is missing and stays stable", async () => {
    const a = await emailKey("src", payload);
    const b = await emailKey("src", payload);
    const c = await emailKey("src", { ...payload, text: "different" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^src_[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// email() happy paths
// ---------------------------------------------------------------------------

describe("email() ingestion", () => {
  it("inserts a parsed plaintext email with the exact PostgREST shape", async () => {
    const { calls, fn } = mockFetch(new Response(null, { status: 201 }));
    const { env, kvPut } = makeEnv();

    await runEmail(makeMessage(), env);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0]!.url).toBe("https://sb.test/rest/v1/raw_emails?on_conflict=email_key");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.apikey).toBe("sk-test");
    expect(headers.Prefer).toContain("ignore-duplicates");

    const row = insertedRow(calls);
    expect(row.email_key).toBe("sdtoday_abc123@mail.sdtoday.com");
    expect(row.source).toBe("sdtoday");
    expect(row.to_addr).toBe("sdtoday@example.com");
    expect(row.from_addr).toBe("news@sdtoday.com");
    expect(row.subject).toBe("Weekend events");
    expect(row.body_text).toBe("Farmers market Saturday 9am at Little Italy.");
    expect(Number.isNaN(Date.parse(row.received_at))).toBe(false);
    expect(kvPut).not.toHaveBeenCalled();
  });

  it("redelivery produces the identical email_key (idempotent)", async () => {
    const { calls } = mockFetch(
      new Response(null, { status: 201 }),
      new Response(null, { status: 201 }),
    );
    const { env } = makeEnv();

    await runEmail(makeMessage(), env);
    await runEmail(makeMessage(), env);

    expect(insertedRow(calls, 0).email_key).toBe(insertedRow(calls, 1).email_key);
  });

  it("falls back to stripped, entity-decoded HTML when there is no text part", async () => {
    const { calls } = mockFetch();
    const { env } = makeEnv();

    await runEmail(makeMessage({ raw: HTML_EMAIL, to: "dostuff@example.com" }), env);

    const row = insertedRow(calls);
    expect(row.source).toBe("dostuff");
    expect(row.body_text).toContain("Hi & welcome");
    expect(row.body_text).toContain("Jazz night — 8pm — free");
    expect(row.body_text).not.toContain("<");
    expect(row.body_text).not.toContain("alert");
    expect(row.body_text).not.toContain("color:red");
  });

  it("normalizes a mixed-case, plus-tagged To: into slug + lowercase address", async () => {
    const { calls } = mockFetch();
    const { env } = makeEnv();

    await runEmail(makeMessage({ to: "John.Doe+news@Example.Com" }), env);

    const row = insertedRow(calls);
    expect(row.source).toBe("john-doe");
    expect(row.to_addr).toBe("john.doe+news@example.com");
    expect(row.email_key.startsWith("john-doe_")).toBe(true);
  });

  it("stores an empty body when the email has neither text nor html", async () => {
    const raw = [
      "From: a@b.com",
      "To: x@example.com",
      "Subject: empty",
      "Message-ID: <empty@b.com>",
      "",
      "",
    ].join("\r\n");
    const { calls } = mockFetch();
    const { env } = makeEnv();

    await runEmail(makeMessage({ raw, to: "x@example.com" }), env);

    expect(insertedRow(calls).body_text).toBe("");
  });

  it("truncates oversized bodies at MAX_BODY_CHARS with a marker", async () => {
    const big = "a".repeat(MAX_BODY_CHARS + 5000);
    const raw = [
      "From: a@b.com",
      "To: x@example.com",
      "Subject: big",
      "Message-ID: <big@b.com>",
      "Content-Type: text/plain",
      "",
      big,
    ].join("\r\n");
    const { calls } = mockFetch();
    const { env } = makeEnv();

    await runEmail(makeMessage({ raw, to: "x@example.com" }), env);

    const row = insertedRow(calls);
    expect(row.body_text.length).toBeLessThan(MAX_BODY_CHARS + 100);
    expect(row.body_text).toContain("[truncated");
  });
});

// ---------------------------------------------------------------------------
// email() degraded paths — malformed input must never bounce mail
// ---------------------------------------------------------------------------

describe("email() degraded input", () => {
  it("skips MIME parsing above MAX_PARSE_BYTES and stores a header-only row", async () => {
    const { calls } = mockFetch();
    const { env } = makeEnv();

    await runEmail(
      makeMessage({
        rawSize: MAX_PARSE_BYTES + 1,
        headers: { subject: "Huge attachment", "message-id": "<huge@x>" },
      }),
      env,
    );

    const row = insertedRow(calls);
    expect(row.subject).toBe("Huge attachment");
    expect(row.body_text).toContain("[body skipped");
    expect(row.email_key).toBe("sdtoday_huge@x");
  });

  it("stores an envelope/header row when MIME parsing fails", async () => {
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new Error("boom"));
      },
    });
    const { calls } = mockFetch();
    const { env, kvPut } = makeEnv();

    await runEmail(
      makeMessage({ raw: broken, headers: { subject: "Hdr subject", "message-id": "<hdr@x>" } }),
      env,
    );

    const row = insertedRow(calls);
    expect(row.subject).toBe("Hdr subject");
    expect(row.body_text).toContain("[body unavailable");
    expect(row.email_key).toBe("sdtoday_hdr@x");
    expect(kvPut).not.toHaveBeenCalled();
  });

  it("survives a missing To: with the unknown fallback", async () => {
    const raw = ["From: a@b.com", "Subject: no recipient", "", "hi"].join("\r\n");
    const { calls } = mockFetch();
    const { env } = makeEnv();

    await runEmail(makeMessage({ raw, to: null }), env);

    const row = insertedRow(calls);
    expect(row.to_addr).toBe("unknown@unknown");
    expect(row.source).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// email() failure paths — retry, dead letter, double failure
// ---------------------------------------------------------------------------

describe("email() failure handling", () => {
  it("retries once on 5xx, then dead-letters to KV with a 30-day TTL", async () => {
    const { fn } = mockFetch(
      new Response("oops", { status: 500 }),
      new Response("oops", { status: 500 }),
    );
    const { env, kvPut } = makeEnv();

    await runEmail(makeMessage(), env);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(kvPut).toHaveBeenCalledTimes(1);
    const [key, value, opts] = kvPut.mock.calls[0]!;
    expect(key).toBe("sdtoday_abc123@mail.sdtoday.com");
    expect(JSON.parse(value).subject).toBe("Weekend events");
    expect(opts).toEqual({ expirationTtl: 60 * 60 * 24 * 30 });
  });

  it("recovers when the retry succeeds — no dead letter", async () => {
    const { fn } = mockFetch(
      new Error("network down"),
      new Response(null, { status: 201 }),
    );
    const { env, kvPut } = makeEnv();

    await runEmail(makeMessage(), env);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(kvPut).not.toHaveBeenCalled();
  });

  it("does not retry config errors (401) — straight to the dead letter", async () => {
    const { fn } = mockFetch(new Response("bad key", { status: 401 }));
    const { env, kvPut } = makeEnv();

    await runEmail(makeMessage(), env);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(kvPut).toHaveBeenCalledTimes(1);
  });

  it("dead-letters immediately when the secret is not configured", async () => {
    const { fn } = mockFetch();
    const { env, kvPut } = makeEnv({ SUPABASE_SECRET_KEY: undefined });

    await runEmail(makeMessage(), env);

    expect(fn).not.toHaveBeenCalled();
    expect(kvPut).toHaveBeenCalledTimes(1);
  });

  it("throws when both Supabase and KV fail, so Cloudflare redelivers", async () => {
    mockFetch(new Response("oops", { status: 503 }), new Response("oops", { status: 503 }));
    const kvPut = vi.fn(async () => {
      throw new Error("kv down");
    });
    const { env } = makeEnv({ kvPut });

    await expect(runEmail(makeMessage(), env)).rejects.toThrow(/dead-letter failed/);
  });
});

// ---------------------------------------------------------------------------
// insertRawEmail guard
// ---------------------------------------------------------------------------

describe("insertRawEmail", () => {
  it("throws before fetching when config is missing", async () => {
    const { fn } = mockFetch();
    await expect(
      insertRawEmail({ RAW_EMAILS: {} as Env["RAW_EMAILS"] }, "k", {
        to: "a@b",
        from: "",
        subject: "",
        text: "",
        receivedAt: "",
      }),
    ).rejects.toThrow(/not configured/);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ingest ping
// ---------------------------------------------------------------------------

describe("ingest ping", () => {
  it("pings INGEST_URL via waitUntil without blocking delivery", async () => {
    const { calls, fn } = mockFetch(
      new Response(null, { status: 201 }),
      new Response(null, { status: 200 }),
    );
    const { env } = makeEnv({ INGEST_URL: "https://api.test/ingest", INGEST_KEY: "shh" });
    const { ctx, waited } = makeCtx();

    await runEmail(makeMessage(), env, ctx);
    await Promise.all(waited);

    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls[1]!.url).toBe("https://api.test/ingest");
    expect((calls[1]!.init.headers as Record<string, string>)["X-Ingest-Key"]).toBe("shh");
  });

  it("a failing ping never rejects the delivery", async () => {
    mockFetch(new Response(null, { status: 201 }), new Error("tunnel down"));
    const { env } = makeEnv({ INGEST_URL: "https://api.test/ingest" });
    const { ctx, waited } = makeCtx();

    await expect(runEmail(makeMessage(), env, ctx)).resolves.toBeUndefined();
    await expect(Promise.all(waited)).resolves.toBeDefined();
  });

  it("skips the ping when INGEST_URL is unset or a placeholder", async () => {
    mockFetch(new Response(null, { status: 201 }));
    const { env } = makeEnv({ INGEST_URL: "https://REPLACE.example.com" });
    const { ctx } = makeCtx();

    await runEmail(makeMessage(), env, ctx);

    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// dead-letter drain (scheduled handler)
// ---------------------------------------------------------------------------

describe("drainDeadLetters", () => {
  it("re-inserts a parked email and deletes it from KV", async () => {
    const { calls } = mockFetch(new Response(null, { status: 201 }));
    const { env, store, del } = makeDrainEnv(PARKED);

    const result = await drainDeadLetters(env);

    expect(result).toEqual({ drained: 1, failed: 0 });
    expect(insertedRow(calls).email_key).toBe("sdtoday_parked1");
    expect(insertedRow(calls).source).toBe("sdtoday");
    expect(insertedRow(calls).subject).toBe("Parked one");
    expect(del).toHaveBeenCalledWith("sdtoday_parked1");
    expect(store).toEqual({});
  });

  it("keeps the copy when Supabase is still down", async () => {
    mockFetch(new Response("nope", { status: 503 }), new Response("nope", { status: 503 }));
    const { env, store, del } = makeDrainEnv(PARKED);

    const result = await drainDeadLetters(env);

    expect(result).toEqual({ drained: 0, failed: 1 });
    expect(del).not.toHaveBeenCalled();
    expect(Object.keys(store)).toEqual(["sdtoday_parked1"]);
  });

  it("skips unparseable values instead of deleting them", async () => {
    const { fn } = mockFetch();
    const { env, store, del } = makeDrainEnv({ junk: "not json" });

    const result = await drainDeadLetters(env);

    expect(result).toEqual({ drained: 0, failed: 1 });
    expect(fn).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(Object.keys(store)).toEqual(["junk"]);
  });

  it("tolerates a key that expired between list and get", async () => {
    const { fn } = mockFetch();
    const { env } = makeDrainEnv({});
    env.RAW_EMAILS.list = (async () => ({
      keys: [{ name: "gone" }],
    })) as unknown as Env["RAW_EMAILS"]["list"];

    await expect(drainDeadLetters(env)).resolves.toEqual({ drained: 0, failed: 0 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("pings the ingest endpoint after a successful drain", async () => {
    const { calls } = mockFetch(
      new Response(null, { status: 201 }),
      new Response(null, { status: 200 }),
    );
    const { env } = makeDrainEnv(PARKED, { INGEST_URL: "https://api.test/ingest" });

    await drainDeadLetters(env);

    expect(calls[1]!.url).toBe("https://api.test/ingest");
  });

  it("the scheduled handler runs the drain inside waitUntil", async () => {
    mockFetch(new Response(null, { status: 201 }));
    const { env, del } = makeDrainEnv(PARKED);
    const { ctx } = makeCtx();

    await runScheduled(env, ctx);

    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith("sdtoday_parked1");
  });
});

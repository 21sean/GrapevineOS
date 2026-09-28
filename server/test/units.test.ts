import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminPosture, isAdminUser } from "../src/admin-gate.js";
import { blockedHost, fetchPublic, isBlockedUrl, jsonLdBlocks } from "../src/agent/websearch.js";
import { llmPolicy } from "../src/budget.js";
import { safeSvg } from "../src/catalog.js";
import { eventsFromJsonLdBlocks, inZone } from "../src/jsonld.js";
import { startLoop } from "../src/lifecycle.js";
import { parseLooseJSON } from "../src/llm-json.js";
import { nextOccurrence, normalizeRRule } from "../src/recurrence.js";
import { rateLimit, singleFlight } from "../src/rate-limit.js";
import { errorHandler } from "../src/request-id.js";
import { safeEqual, validateSecrets } from "../src/secrets.js";

const user = {
  id: "u1",
  email: "Admin@Example.com",
  name: "A",
  picture: "",
  createdAt: "",
  lastLoginAt: "",
};

describe("the admin gate", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("is an allowlist when ADMIN_EMAILS is set, case-insensitively", () => {
    process.env.ADMIN_EMAILS = "admin@example.com, other@example.com";
    expect(adminPosture()).toBe("allowlist");
    expect(isAdminUser(user)).toBe(true);
    expect(isAdminUser({ ...user, email: "nobody@example.com" })).toBe(false);
    expect(isAdminUser(null)).toBe(false);
  });

  it("is open on a laptop and closed in production when unset", () => {
    delete process.env.ADMIN_EMAILS;
    process.env.NODE_ENV = "development";
    expect(adminPosture()).toBe("open");
    expect(isAdminUser(null)).toBe(true);
    process.env.NODE_ENV = "production";
    expect(adminPosture()).toBe("closed");
    expect(isAdminUser(user)).toBe(false);
  });
});

describe("secrets", () => {
  it("refuses to start on example values and names all of them", () => {
    expect(() =>
      validateSecrets({ INGEST_SHARED_KEY: "change_me", AGENT_API_KEY: "change_me_too" }),
    ).toThrow(/INGEST_SHARED_KEY, AGENT_API_KEY/);
    expect(() => validateSecrets({ SUPABASE_URL: "https://your-project.supabase.co" })).toThrow(
      /SUPABASE_URL/,
    );
    expect(() => validateSecrets({ SUPABASE_SECRET_KEY: "sb_secret_your_key" })).toThrow();
    expect(() =>
      validateSecrets({ SUPABASE_SECRET_KEY: "sb_secret_abc123", INGEST_SHARED_KEY: "f3a9..." }),
    ).not.toThrow();
    expect(() => validateSecrets({})).not.toThrow();
  });

  it("compares keys in constant time and never treats missing as equal", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual(undefined, undefined)).toBe(false);
    expect(safeEqual("", "")).toBe(false);
  });
});

describe("rate limits", () => {
  const req = (ip: string) => ({ ip }) as Request;
  const res = () => {
    const r = { statusCode: 200, headers: {} as Record<string, string>, body: null as unknown };
    return Object.assign(r, {
      setHeader: (k: string, v: string) => {
        r.headers[k] = v;
      },
      status: (code: number) => {
        r.statusCode = code;
        return r;
      },
      json: (body: unknown) => {
        r.body = body;
        return r;
      },
      once: () => r,
    }) as unknown as Response & typeof r;
  };

  it("counts per address inside a window", () => {
    const limit = rateLimit({ name: "test", windowMs: 60_000, max: 2 });
    let passed = 0;
    for (let i = 0; i < 3; i++) limit(req("1.1.1.1"), res(), () => passed++);
    expect(passed).toBe(2);
    let other = 0;
    limit(req("2.2.2.2"), res(), () => other++);
    expect(other).toBe(1);
  });

  it("allows one in-flight request per key until it closes", async () => {
    const flight = singleFlight({ name: "test", key: () => "same" });
    const first = res();
    let handlers: (() => void)[] = [];
    (first as unknown as { once: (e: string, h: () => void) => void }).once = (_e, h) => {
      handlers.push(h);
    };
    let passed = 0;
    await flight(req("x"), first, () => passed++);
    const second = res();
    await flight(req("x"), second, () => passed++);
    expect(passed).toBe(1);
    expect(second.statusCode).toBe(429);
    for (const h of handlers) h();
    handlers = [];
    await flight(req("x"), res(), () => passed++);
    expect(passed).toBe(2);
  });
});

describe("the SSRF guard", () => {
  it("blocks local, private and link-local hosts by name and address", () => {
    for (const h of [
      "localhost",
      "ollama.local",
      "api.internal",
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "::ffff:7f00:1",
      "[fd00::1]",
      "100.64.0.1",
      "dev.localhost",
    ]) {
      expect(blockedHost(h), h).toBe(true);
    }
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "fcc.gov", "fdic.gov", "fe80.io"]) {
      expect(blockedHost(h), h).toBe(false);
    }
  });

  it("re-checks every redirect hop", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:11434/api/tags" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(fetchPublic("http://93.184.215.14/go")).rejects.toThrow("url not allowed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects non-http schemes and bad urls", () => {
    expect(isBlockedUrl("file:///etc/passwd")).toBe(true);
    expect(isBlockedUrl("ftp://example.com/x")).toBe(true);
    expect(isBlockedUrl("not a url")).toBe(true);
    expect(isBlockedUrl("https://example.com/events")).toBe(false);
  });

  it("pulls JSON-LD blocks out of raw markup without a DOM", () => {
    const html = `<html><head><script type="application/ld+json">{"@type":"Event"}</script>
      <script type='application/ld+json'>  {"@type":"Place"}  </script><script>var x = 1</script></head></html>`;
    expect(jsonLdBlocks(html)).toEqual(['{"@type":"Event"}', '{"@type":"Place"}']);
    expect(jsonLdBlocks("<p>no markup</p>")).toEqual([]);
  });
});

describe("loose JSON", () => {
  it("salvages JSON from think tags, fences and prose", () => {
    expect(parseLooseJSON('<think>hmm</think>```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseLooseJSON('Sure! Here it is: {"a":{"b":2}} hope that helps')).toEqual({
      a: { b: 2 },
    });
    expect(() => parseLooseJSON("nothing here")).toThrow(/unparseable/);
  });
});

describe("the LLM policy", () => {
  it("never retries a subscription CLI and gives it a longer leash", () => {
    const ollama = llmPolicy("ollama");
    const claude = llmPolicy("claude");
    expect(ollama.retries).toBeGreaterThanOrEqual(1);
    expect(claude.retries).toBe(0);
    expect(claude.idleTimeoutMs).toBeGreaterThan(ollama.idleTimeoutMs);
    expect(claude.timeoutMs).toBeLessThan(120_000);
  });
});

describe("the error handler", () => {
  const fakeRes = () => {
    const r = {
      statusCode: 200,
      body: null as unknown,
      headersSent: false,
      locals: { requestId: "req-1" },
    };
    return Object.assign(r, {
      status: (code: number) => {
        r.statusCode = code;
        return r;
      },
      json: (body: unknown) => {
        r.body = body;
        return r;
      },
      end: () => r,
    }) as unknown as Response & typeof r;
  };
  const req = { method: "GET", path: "/api/x" } as Request;

  it("answers 502 for a dependency that did not answer and 500 otherwise, with the request id and no stack", () => {
    const upstream = fakeRes();
    errorHandler(new Error("fetch failed: ECONNREFUSED 127.0.0.1:11434"), req, upstream, () => {});
    expect(upstream.statusCode).toBe(502);
    expect(upstream.body).toEqual({
      error: "fetch failed: ECONNREFUSED 127.0.0.1:11434",
      requestId: "req-1",
    });

    const bug = fakeRes();
    errorHandler(new TypeError("x is not a function"), req, bug, () => {});
    expect(bug.statusCode).toBe(500);
    expect(JSON.stringify(bug.body)).not.toMatch(/at .*\.ts/);
  });
});

describe("JSON-LD dates without an offset", () => {
  const tz = "America/Los_Angeles";

  it("are wall-clock time in the city, on either side of a DST change", () => {
    expect(inZone("2026-08-08", tz)).toBe("2026-08-08T00:00:00-07:00");
    expect(inZone("2026-03-08", tz)).toBe("2026-03-08T00:00:00-08:00");
    expect(inZone("2026-03-08T12:00", tz)).toBe("2026-03-08T12:00:00-07:00");
    expect(inZone("2026-08-08T19:30:00-04:00", tz)).toBe("2026-08-08T19:30:00-04:00");
  });

  it("treat a single-day midnight start as a missing hour", () => {
    const block = (startDate: string) =>
      JSON.stringify({ "@type": "Event", name: "Show", startDate, location: "Venue" });
    const [midnight] = eventsFromJsonLdBlocks(
      [block("2026-08-15T00:00:00-07:00")],
      "https://x.test",
      tz,
    );
    const [evening] = eventsFromJsonLdBlocks([block("2026-08-15T19:30:00")], "https://x.test", tz);
    expect(midnight.precise).toBe(false);
    expect(evening.precise).toBe(true);
    expect(evening.start).toBe("2026-08-15T19:30:00-07:00");
  });
});

describe("proxied logos", () => {
  it("passes plain vector art through", () => {
    const svg = `<svg viewBox="0 0 24 24"><use href="#a"/><path fill="currentColor" d="M0 0h24v24H0z"/></svg>`;
    expect(safeSvg(`  ${svg}\n`)).toBe(svg);
    expect(safeSvg(`<?xml version="1.0"?>\n${svg}`)).not.toBeNull();
  });

  it("refuses anything that can run or load something once inlined", () => {
    for (const bad of [
      `<svg><script>alert(1)</script></svg>`,
      `<svg onload="alert(1)"></svg>`,
      `<svg><animate onbegin=alert(1) attributeName="x"/></svg>`,
      `<svg><foreignObject><img src=x></foreignObject></svg>`,
      `<svg><a href="javascript:alert(1)"><text>x</text></a></svg>`,
      `<svg><image xlink:href="https://tracker.example/p.png"/></svg>`,
      `<html><body>not an svg</body></html>`,
    ]) {
      expect(safeSvg(bad)).toBeNull();
    }
  });
});

describe("loops", () => {
  it("never overlaps a slow pass with the next tick, and starts nothing when disabled", async () => {
    vi.useFakeTimers();
    let running = 0;
    let maxRunning = 0;
    let passes = 0;
    startLoop({
      name: "test",
      enabled: true,
      intervalMs: 10,
      immediate: true,
      run: async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        passes++;
        await new Promise((r) => setTimeout(r, 35));
        running--;
      },
    });
    let disabledPasses = 0;
    startLoop({
      name: "off",
      enabled: false,
      intervalMs: 10,
      run: async () => void disabledPasses++,
    });
    await vi.advanceTimersByTimeAsync(100);
    vi.useRealTimers();
    expect(maxRunning).toBe(1);
    expect(passes).toBeGreaterThanOrEqual(2);
    expect(disabledPasses).toBe(0);
  });
});

describe("recurrence", () => {
  const tz = "America/Los_Angeles";
  const wall = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso));

  it("keeps a weekly evening at the same local hour across the fall DST change", () => {
    const e = {
      start: "2026-10-31T19:00:00-07:00",
      end: "2026-10-31T21:00:00-07:00",
      recurrence: "FREQ=WEEKLY;BYDAY=SA",
    };
    const next = nextOccurrence(e, new Date("2026-11-01T12:00:00-07:00"), tz);
    expect(wall(next.start)).toBe("Sat, Nov 7, 7:00 PM PST");
  });

  it("treats a monthly ordinal as the nth weekday, not every weekday", () => {
    expect(normalizeRRule("FREQ=MONTHLY;BYDAY=1MO")).toBe("FREQ=MONTHLY;BYDAY=1MO");
    const e = {
      start: "2026-09-07T19:00:00-07:00",
      end: "2026-09-07T21:00:00-07:00",
      recurrence: "FREQ=MONTHLY;BYDAY=1MO",
    };
    const next = nextOccurrence(e, new Date("2026-09-08T12:00:00-07:00"), tz);
    expect(wall(next.start)).toBe("Mon, Oct 5, 7:00 PM PDT");
  });

  it("includes the whole local day of a date-only UNTIL", () => {
    const e = {
      start: "2026-09-05T19:00:00-07:00",
      end: "2026-09-05T21:00:00-07:00",
      recurrence: "FREQ=WEEKLY;BYDAY=SA;UNTIL=20261003",
    };
    const last = nextOccurrence(e, new Date("2026-10-04T12:00:00-07:00"), tz);
    expect(wall(last.start)).toBe("Sat, Oct 3, 7:00 PM PDT");
  });
});

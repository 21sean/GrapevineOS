import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** The confirm half of the chat's rarity card: the only way the chat can change rarity. */
const seen = vi.hoisted(() => ({ admin: true, updates: [] as unknown[][] }));
vi.mock("../src/auth.js", () => ({
  requireAdmin: (_req: unknown, res: express.Response, next: () => void) => {
    if (seen.admin) next();
    else res.status(403).json({ error: "admin only" });
  },
  sessionUser: async () => null,
}));
vi.mock("../src/ingest.js", () => ({ rateEvent: async () => ({}) }));
vi.mock("../src/store.js", () => ({
  store: {
    eventById: async (id: string) => (id === "known" ? { id, title: "Known" } : undefined),
    updateEvent: async (id: string, patch: unknown) => {
      seen.updates.push([id, patch]);
      return { id, ...(patch as object) };
    },
  },
}));

import { events } from "../src/routes/events.js";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(events);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  seen.admin = true;
  seen.updates.length = 0;
});

const post = (id: string, rarity: unknown) =>
  fetch(`${base}/api/events/${id}/rarity`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rarity }),
  });

describe("confirming a rarity change", () => {
  it("writes the confirmed value", async () => {
    const res = await post("known", "rare");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "known", rarity: "rare" });
    expect(seen.updates).toEqual([["known", { rarity: "rare" }]]);
  });

  it("is an admin write, whatever the card said", async () => {
    seen.admin = false;
    const res = await post("known", "rare");
    expect(res.status).toBe(403);
    expect(seen.updates).toEqual([]);
  });

  it("refuses a value outside the vocabulary and an unknown event", async () => {
    expect((await post("known", "legendary")).status).toBe(400);
    expect((await post("missing", "rare")).status).toBe(404);
    expect(seen.updates).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db.js";

vi.mock("../src/db.js", async () => {
  const { fakeDb } = await import("./fake-db.js");
  return { db: fakeDb };
});

const { store } = await import("../src/store.js");
const now = new Date("2026-10-14T20:00:00Z");

function row(id: string, start: string, end: string, recurrence: string | null = null) {
  return {
    id,
    title: id,
    description: "",
    category: "community",
    tags: [],
    venue: "San Diego",
    lng: -117.16,
    lat: 32.72,
    starts_at: start,
    ends_at: end,
    recurrence,
    price: "Free",
    is_free: true,
    source_id: "test",
    source_kind: "manual",
    rating: 3,
    promoted: false,
    rarity: "common",
  };
}

describe("event catalog", () => {
  beforeEach(() => {
    fakeDb.reset();
    vi.spyOn(store, "settings").mockResolvedValue({ tz: "America/Los_Angeles" } as Awaited<
      ReturnType<typeof store.settings>
    >);
  });

  it("reads past the PostgREST row cap and keeps chronological order", async () => {
    fakeDb.tables.events = Array.from({ length: 1205 }, (_, i) =>
      row(`event-${String(i).padStart(4, "0")}`, "2026-11-01T18:00:00Z", "2026-11-01T20:00:00Z"),
    );
    fakeDb.tables.events.push(row("aaa-december", "2026-12-31T18:00:00Z", "2026-12-31T20:00:00Z"));
    const events = await store.events();
    expect(events).toHaveLength(1206);
    expect(new Set(events.map((e) => e.id)).size).toBe(1206);
    expect(events.at(-1)?.id).toBe("aaa-december");
  });

  it("hides ended one-offs and exhausted series while preserving live and recurring events", async () => {
    fakeDb.tables.events = [
      row("past", "2026-10-13T18:00:00Z", "2026-10-13T20:00:00Z"),
      row("live", "2026-10-14T19:00:00Z", "2026-10-14T21:00:00Z"),
      row("at-end", "2026-10-14T19:00:00Z", now.toISOString()),
      row("future", "2026-12-31T18:00:00Z", "2026-12-31T20:00:00Z"),
      row("weekly", "2026-07-04T16:00:00Z", "2026-07-04T20:00:00Z", "FREQ=WEEKLY;BYDAY=SA"),
      row(
        "expired",
        "2026-07-04T16:00:00Z",
        "2026-07-04T20:00:00Z",
        "FREQ=WEEKLY;BYDAY=SA;UNTIL=20260801",
      ),
    ];
    const events = await store.events({ upcomingOnly: true, now });
    expect(events.map((e) => e.id).sort()).toEqual(["at-end", "future", "live", "weekly"]);
    expect(await store.events()).toHaveLength(6);
  });

  it("paginates the upcoming query too", async () => {
    fakeDb.tables.events = Array.from({ length: 1005 }, (_, i) =>
      row(`event-${String(i).padStart(4, "0")}`, "2026-12-01T18:00:00Z", "2026-12-01T20:00:00Z"),
    );
    expect(await store.events({ upcomingOnly: true, now })).toHaveLength(1005);
  });
});

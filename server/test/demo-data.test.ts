import { describe, expect, it } from "vitest";
import { demoEvents } from "../scripts/demo-data.js";

describe("demo data", () => {
  it.each(["2026-12-31T23:59:59Z", "2028-02-29T12:00:00Z", "2032-03-14T09:59:59Z"])(
    "stays upcoming across calendar boundaries: %s",
    (date) => {
      const now = new Date(date);
      const events = demoEvents(now);
      expect(events).toHaveLength(7);
      expect(new Set(events.map((e) => e.category)).size).toBe(7);
      for (const event of events) {
        expect(Date.parse(event.starts_at)).toBeGreaterThan(now.getTime());
        expect(Date.parse(event.ends_at)).toBeGreaterThan(Date.parse(event.starts_at));
        expect(event.title).toMatch(/^\[Demo\]/);
        expect(event.source_kind).toBe("seed");
      }
    },
  );
  it("keeps row identities stable when dates advance", () => {
    const before = demoEvents(new Date("2026-01-01"));
    const after = demoEvents(new Date("2030-01-01"));
    expect(after.map((e) => [e.id, e.dedupe_key])).toEqual(before.map((e) => [e.id, e.dedupe_key]));
    expect(after[0].starts_at).not.toEqual(before[0].starts_at);
  });
});

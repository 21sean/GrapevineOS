import { describe, expect, it } from "vitest";
import { askedToAddEvents, namesEvent, splitCalendarSave } from "../src/agent/write-gate.js";

const moonchild = { id: "casbah-moonchild", title: "Moonchild" };
const vip = { id: "gaslamp-bottle-service", title: "VIP Bottle Night with Guest DJ" };
const padres = { id: "padres-giants", title: "Padres vs. San Francisco Giants" };
const events = [moonchild, vip, padres];
const intent = (userText: string, priorAnswer = "") => ({ userText, priorAnswer });

describe("names an event", () => {
  it("by a word only its title has, an id, or a link", () => {
    expect(namesEvent("add the moonchild show", moonchild)).toBe(true);
    expect(namesEvent("the padres game", padres)).toBe(true);
    expect(namesEvent("see [VIP](event:gaslamp-bottle-service)", vip)).toBe(true);
  });

  it("not by the common words any title might have", () => {
    expect(namesEvent("what is on tonight, any good night out?", vip)).toBe(false);
    expect(namesEvent("add it to my calendar", moonchild)).toBe(false);
  });
});

describe("saving to the calendar", () => {
  it("saves what the person named", () => {
    expect(
      splitCalendarSave(["casbah-moonchild"], events, intent("Add the Moonchild show")),
    ).toEqual({ save: ["casbah-moonchild"], propose: [] });
  });

  it("turns an event the person never named into a card", () => {
    expect(
      splitCalendarSave(
        ["casbah-moonchild", "gaslamp-bottle-service"],
        events,
        intent("Add the Moonchild show to my calendar."),
      ),
    ).toEqual({ save: ["casbah-moonchild"], propose: ["gaslamp-bottle-service"] });
  });

  it("saves nothing when the person asked for no write at all", () => {
    expect(
      splitCalendarSave(["gaslamp-bottle-service"], events, intent("What free things are on?")),
    ).toEqual({ save: [], propose: ["gaslamp-bottle-service"] });
  });

  it("does not count a question that happens to name the event as asking to save it", () => {
    expect(
      splitCalendarSave(
        ["gaslamp-bottle-service"],
        events,
        intent("How much is VIP Bottle Night?"),
      ),
    ).toEqual({ save: [], propose: ["gaslamp-bottle-service"] });
  });

  it("honors 'yes, book those' for what the previous reply offered, and only that", () => {
    const offered = "Try [Moonchild](event:casbah-moonchild) at the Casbah tonight.";
    expect(
      splitCalendarSave(
        ["casbah-moonchild", "gaslamp-bottle-service"],
        events,
        intent("yes, book those", offered),
      ),
    ).toEqual({ save: ["casbah-moonchild"], propose: ["gaslamp-bottle-service"] });
    expect(splitCalendarSave(["casbah-moonchild"], events, intent("do it", offered)).save).toEqual([
      "casbah-moonchild",
    ]);
  });

  it("proposes an id the catalog does not know", () => {
    expect(splitCalendarSave(["nope"], events, intent("save nope"))).toEqual({
      save: [],
      propose: ["nope"],
    });
  });
});

describe("adding to the catalog", () => {
  it("needs the person to ask for events to be added", () => {
    expect(askedToAddEvents(intent("Add those events to the map"))).toBe(true);
    expect(askedToAddEvents(intent("yes, add them"))).toBe(true);
    expect(askedToAddEvents(intent("What free things can I do tonight?"))).toBe(false);
    expect(askedToAddEvents(intent("Find me jazz shows on the web"))).toBe(false);
  });
});

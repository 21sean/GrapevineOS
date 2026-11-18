import { expect, it } from "vitest";
import { Scheduler, type Limits } from "../src/llm/scheduler.js";

const limits = (over: Partial<Limits> = {}): Limits => ({
  concurrency: 2,
  backgroundSlots: 1,
  maxQueued: { interactive: 4, background: 4 },
  maxPreemptions: 2,
  ...over,
});

/** Carry out decisions until nothing more can start: what started, and what was stopped. */
function settle(s: Scheduler<string>, l: Limits, admitted = true) {
  const started: string[] = [];
  const stopped: string[] = [];
  for (;;) {
    const decision = s.next(l, admitted);
    if (!decision) return { started, stopped };
    if ("preempt" in decision) {
      stopped.push(decision.preempt.payload);
      s.requeue(decision.preempt);
    } else started.push(decision.run.payload);
  }
}

it("starts interactive work first, whatever order it arrived in", () => {
  const s = new Scheduler<string>();
  s.enqueue("background", "inbox", limits());
  s.enqueue("interactive", "chat", limits());
  expect(settle(s, limits()).started).toEqual(["chat", "inbox"]);
});

it("keeps background work to its share of the slots", () => {
  const s = new Scheduler<string>();
  const l = limits({ concurrency: 4, backgroundSlots: 2 });
  for (const name of ["a", "b", "c"]) s.enqueue("background", name, l);
  expect(settle(s, l).started).toEqual(["a", "b"]);
  expect(s.running()).toEqual({ interactive: 0, background: 2 });
  expect(s.queued().background).toBe(1);
});

it("stops the newest background job when a person finds every slot busy", () => {
  const s = new Scheduler<string>();
  const l = limits({ concurrency: 2, backgroundSlots: 2 });
  const older = s.enqueue("background", "older", l)!;
  const newer = s.enqueue("background", "newer", l)!;
  settle(s, l);
  const chat = s.enqueue("interactive", "chat", l)!;
  expect(settle(s, l)).toEqual({ started: ["chat"], stopped: ["newer"] });
  expect([s.isRunning(older), s.isRunning(newer), s.isRunning(chat)]).toEqual([true, false, true]);
  // The stopped job is first in line again, ahead of anything that arrived after it.
  s.enqueue("background", "latecomer", l);
  s.finish(chat);
  expect(settle(s, l).started).toEqual(["newer"]);
});

it("stops a job only so many times, then lets it finish", () => {
  const s = new Scheduler<string>();
  const l = limits({ concurrency: 1, backgroundSlots: 1, maxPreemptions: 1 });
  const inbox = s.enqueue("background", "inbox", l)!;
  settle(s, l);
  const first = s.enqueue("interactive", "first", l)!;
  expect(settle(s, l)).toEqual({ started: ["first"], stopped: ["inbox"] });
  s.finish(first);
  expect(settle(s, l).started).toEqual(["inbox"]);
  // Already stopped once: this time the person waits for it instead.
  s.enqueue("interactive", "second", l);
  expect(settle(s, l)).toEqual({ started: [], stopped: [] });
  s.finish(inbox);
  expect(settle(s, l).started).toEqual(["second"]);
});

it("never stops interactive work for more interactive work", () => {
  const s = new Scheduler<string>();
  const l = limits({ concurrency: 1 });
  s.enqueue("interactive", "one", l);
  settle(s, l);
  s.enqueue("interactive", "two", l);
  expect(settle(s, l)).toEqual({ started: [], stopped: [] });
});

it("holds background work while the runtime reports no headroom, and nothing else", () => {
  const s = new Scheduler<string>();
  s.enqueue("background", "inbox", limits());
  expect(settle(s, limits(), false).started).toEqual([]);
  s.enqueue("interactive", "chat", limits());
  expect(settle(s, limits(), false).started).toEqual(["chat"]);
  expect(settle(s, limits(), true).started).toEqual(["inbox"]);
});

it("refuses work past a queue's limit and forgets what is withdrawn", () => {
  const s = new Scheduler<string>();
  const l = limits({ concurrency: 1, maxQueued: { interactive: 1, background: 1 } });
  s.enqueue("interactive", "running", l);
  settle(s, l);
  const waiting = s.enqueue("interactive", "waiting", l)!;
  expect(s.enqueue("interactive", "one too many", l)).toBeNull();
  expect(s.drop(waiting)).toBe(true);
  expect(s.drop(waiting)).toBe(false);
  expect(s.enqueue("interactive", "room again", l)).not.toBeNull();
});

it("hands back everything on shutdown, running work first", () => {
  const s = new Scheduler<string>();
  const l = limits({ concurrency: 1 });
  s.enqueue("interactive", "running", l);
  settle(s, l);
  s.enqueue("background", "queued", l);
  expect(s.drain().map((t) => t.payload)).toEqual(["running", "queued"]);
  expect(s.running()).toEqual({ interactive: 0, background: 0 });
  expect(s.queued()).toEqual({ interactive: 0, background: 0 });
});

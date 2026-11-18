/**
 * Who gets the GPU next. Pure bookkeeping: no processes, no clocks, no I/O, so the
 * policy can be tested exhaustively and the gateway only has to carry it out.
 *
 * Two classes. Interactive is a person waiting on a chat turn; background is
 * everything that can wait (inbox extraction, discovery, grading, judges). The rules:
 *
 *  1. Interactive work always goes first.
 *  2. Background work may fill at most `backgroundSlots` of the runtime's slots, so a
 *     burst of newsletters cannot occupy every sequence a multi-stream runtime has.
 *  3. When every slot is busy and a person is waiting, the newest background job is
 *     preempted and put back at the head of its queue. Generation has no side effect
 *     until its result is validated, so rerunning it is safe. A job is preempted at
 *     most `maxPreemptions` times, which bounds how long chat can starve the inbox.
 *  4. Background work is admitted only while the runtime reports headroom
 *     (see admission.ts). Interactive work is not gated by load.
 *
 * Within a class the order is first come, first served. The chat route already allows
 * one stream per account, so that order is also fair across people.
 */

export type Priority = "interactive" | "background";

export interface Limits {
  /** Generations the runtime is given at once. */
  concurrency: number;
  /** How many of those background work may hold. */
  backgroundSlots: number;
  maxQueued: Record<Priority, number>;
  maxPreemptions: number;
}

export interface Ticket<T> {
  priority: Priority;
  payload: T;
  /** Times this job was stopped to let a person through. */
  preemptions: number;
  /** Dispatch order, so "newest" does not depend on a clock. */
  sequence: number;
}

export type Decision<T> = { run: Ticket<T> } | { preempt: Ticket<T> } | null;

export class Scheduler<T> {
  private readonly queues: Record<Priority, Ticket<T>[]> = { interactive: [], background: [] };
  private readonly active = new Set<Ticket<T>>();
  private dispatched = 0;

  /** Null when the class's queue is full: the caller reports busy. */
  enqueue(priority: Priority, payload: T, limits: Limits): Ticket<T> | null {
    if (this.queues[priority].length >= limits.maxQueued[priority]) return null;
    const ticket: Ticket<T> = { priority, payload, preemptions: 0, sequence: 0 };
    this.queues[priority].push(ticket);
    return ticket;
  }

  /**
   * The next thing to do, or null when nothing can start. Call again after acting on
   * the answer: one call makes one decision.
   */
  next(limits: Limits, backgroundAdmitted: boolean): Decision<T> {
    const running = this.running();
    const full = running.interactive + running.background >= limits.concurrency;
    if (this.queues.interactive.length) {
      if (!full) return { run: this.start(this.queues.interactive.shift()!) };
      const victim = this.victim(limits);
      return victim ? { preempt: victim } : null;
    }
    if (full || !backgroundAdmitted) return null;
    if (!this.queues.background.length) return null;
    if (running.background >= limits.backgroundSlots) return null;
    return { run: this.start(this.queues.background.shift()!) };
  }

  /** A running job ended, however it ended. */
  finish(ticket: Ticket<T>): void {
    this.active.delete(ticket);
  }

  /** A queued job was cancelled or timed out before it started. */
  drop(ticket: Ticket<T>): boolean {
    const queue = this.queues[ticket.priority];
    const at = queue.indexOf(ticket);
    if (at < 0) return false;
    queue.splice(at, 1);
    return true;
  }

  /** Put a preempted job back first in line, ahead of work that arrived after it. */
  requeue(ticket: Ticket<T>): void {
    this.active.delete(ticket);
    ticket.preemptions++;
    this.queues[ticket.priority].unshift(ticket);
  }

  isRunning(ticket: Ticket<T>): boolean {
    return this.active.has(ticket);
  }

  running(): Record<Priority, number> {
    const count = { interactive: 0, background: 0 };
    for (const ticket of this.active) count[ticket.priority]++;
    return count;
  }

  queued(): Record<Priority, number> {
    return {
      interactive: this.queues.interactive.length,
      background: this.queues.background.length,
    };
  }

  /** Everything, running first, for shutdown. Empties the scheduler. */
  drain(): Ticket<T>[] {
    const all = [...this.active, ...this.queues.interactive, ...this.queues.background];
    this.active.clear();
    this.queues.interactive.length = 0;
    this.queues.background.length = 0;
    return all;
  }

  private start(ticket: Ticket<T>): Ticket<T> {
    ticket.sequence = ++this.dispatched;
    this.active.add(ticket);
    return ticket;
  }

  /** The background job that has done the least work and may still be stopped. */
  private victim(limits: Limits): Ticket<T> | null {
    let newest: Ticket<T> | null = null;
    for (const ticket of this.active) {
      if (ticket.priority !== "background" || ticket.preemptions >= limits.maxPreemptions) continue;
      if (!newest || ticket.sequence > newest.sequence) newest = ticket;
    }
    return newest;
  }
}

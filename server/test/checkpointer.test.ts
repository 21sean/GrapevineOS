import type { RunnableConfig } from "@langchain/core/runnables";
import { emptyCheckpoint, ERROR, type Checkpoint } from "@langchain/langgraph-checkpoint";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./fake-db.js";

vi.mock("../src/db.js", async () => {
  const { fakeDb } = await import("./fake-db.js");
  return { db: fakeDb };
});

const { SupabaseSaver, pruneChatCheckpoints } = await import("../src/checkpointer.js");

/** A checkpoint with a lexicographically sortable id, the way uuid6 ids sort in time. */
function checkpoint(n: number, values: Record<string, unknown> = {}): Checkpoint {
  const c = emptyCheckpoint();
  c.id = `cp-${String(n).padStart(3, "0")}`;
  c.channel_values = values;
  return c;
}

const thread = (id: string, checkpointId?: string) => ({
  configurable: {
    thread_id: id,
    checkpoint_ns: "",
    ...(checkpointId && { checkpoint_id: checkpointId }),
  },
});

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("SupabaseSaver", () => {
  beforeEach(() => fakeDb.reset());

  it("round-trips a checkpoint with its metadata and parent", async () => {
    const saver = new SupabaseSaver();
    const first = await saver.put(
      thread("t1"),
      checkpoint(1, { messages: ["hi"] }),
      { source: "input", step: 0, parents: {} },
      {},
    );
    await saver.put(
      first,
      checkpoint(2, { messages: ["hi", "there"] }),
      { source: "loop", step: 1, parents: {} },
      {},
    );

    const tuple = await saver.getTuple(thread("t1"));
    expect(tuple?.checkpoint.id).toBe("cp-002");
    expect(tuple?.checkpoint.channel_values).toEqual({ messages: ["hi", "there"] });
    expect(tuple?.metadata).toMatchObject({ source: "loop", step: 1 });
    expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe("cp-001");

    const older = await saver.getTuple(thread("t1", "cp-001"));
    expect(older?.checkpoint.channel_values).toEqual({ messages: ["hi"] });
  });

  it("returns pending writes in order, and never mixes threads", async () => {
    const saver = new SupabaseSaver();
    const cfg = await saver.put(
      thread("t1"),
      checkpoint(1),
      { source: "input", step: 0, parents: {} },
      {},
    );
    await saver.putWrites(
      cfg,
      [
        ["messages", "a"],
        ["messages", "b"],
      ],
      "task-1",
    );
    // Special channels overwrite; ordinary writes keep their first value.
    await saver.putWrites(cfg, [[ERROR, "boom"]], "task-1");
    await saver.putWrites(cfg, [[ERROR, "boom again"]], "task-1");
    await saver.putWrites(cfg, [["messages", "not this"]], "task-1");
    await saver.put(thread("t2"), checkpoint(1), { source: "input", step: 0, parents: {} }, {});

    const tuple = await saver.getTuple(thread("t1"));
    const writes = tuple?.pendingWrites ?? [];
    expect(writes.map(([task, channel, value]) => [task, channel, value])).toEqual([
      ["task-1", ERROR, "boom again"],
      ["task-1", "messages", "a"],
      ["task-1", "messages", "b"],
    ]);
    expect((await saver.getTuple(thread("t2")))?.pendingWrites).toEqual([]);
  });

  it("lists newest first, honouring limit and before", async () => {
    const saver = new SupabaseSaver();
    let cfg: RunnableConfig = thread("t1");
    for (let n = 1; n <= 5; n++) {
      cfg = await saver.put(cfg, checkpoint(n), { source: "loop", step: n, parents: {} }, {});
    }
    const ids = async (opts?: Parameters<typeof saver.list>[1]) => {
      const out: string[] = [];
      for await (const t of saver.list(thread("t1"), opts)) out.push(t.checkpoint.id);
      return out;
    };
    expect(await ids()).toEqual(["cp-005", "cp-004", "cp-003", "cp-002", "cp-001"]);
    expect(await ids({ limit: 2 })).toEqual(["cp-005", "cp-004"]);
    expect(await ids({ before: thread("t1", "cp-003") })).toEqual(["cp-002", "cp-001"]);
  });

  it("prunes a thread to its newest checkpoints as it grows", async () => {
    const saver = new SupabaseSaver();
    let cfg: RunnableConfig = thread("t1");
    for (let n = 1; n <= 20; n++) {
      cfg = await saver.put(cfg, checkpoint(n), { source: "loop", step: n, parents: {} }, {});
      await saver.putWrites(cfg, [["messages", `m${n}`]], `task-${n}`);
    }
    await tick();
    const kept = fakeDb.rows("chat_checkpoints").map((r) => r.checkpoint_id);
    // Pruned at put 8 (nothing to drop) and put 16 (down to 12), then four more.
    expect(kept).toHaveLength(16);
    expect(kept).not.toContain("cp-001");
    expect(kept).toContain("cp-020");
    // The writes of the pruned checkpoints went with them.
    const writeIds = new Set(fakeDb.rows("chat_checkpoint_writes").map((r) => r.checkpoint_id));
    expect(writeIds.has("cp-001")).toBe(false);
    expect(writeIds.has("cp-020")).toBe(true);
  });

  it("deleteThread removes the thread's checkpoints and writes, nothing else", async () => {
    const saver = new SupabaseSaver();
    const a = await saver.put(
      thread("a"),
      checkpoint(1),
      { source: "input", step: 0, parents: {} },
      {},
    );
    await saver.putWrites(a, [["messages", "x"]], "task");
    await saver.put(thread("b"), checkpoint(1), { source: "input", step: 0, parents: {} }, {});
    await saver.deleteThread("a");
    expect(await saver.getTuple(thread("a"))).toBeUndefined();
    expect(fakeDb.rows("chat_checkpoint_writes")).toHaveLength(0);
    expect((await saver.getTuple(thread("b")))?.checkpoint.id).toBe("cp-001");
  });

  it("degrades to no memory when the database does not answer", async () => {
    const saver = new SupabaseSaver();
    fakeDb.failing = true;
    const cfg = await saver.put(
      thread("t1"),
      checkpoint(1),
      { source: "input", step: 0, parents: {} },
      {},
    );
    expect(cfg.configurable?.checkpoint_id).toBe("cp-001");
    await expect(saver.putWrites(cfg, [["messages", "x"]], "task")).resolves.toBeUndefined();
    expect(await saver.getTuple(thread("t1"))).toBeUndefined();
  });

  it("the retention backstop deletes checkpoints older than the cutoff", async () => {
    const saver = new SupabaseSaver();
    await saver.put(thread("t1"), checkpoint(1), { source: "input", step: 0, parents: {} }, {});
    expect(await pruneChatCheckpoints(new Date(Date.now() - 60_000))).toBe(0);
    expect(await pruneChatCheckpoints(new Date(Date.now() + 60_000))).toBe(1);
    expect(fakeDb.rows("chat_checkpoints")).toHaveLength(0);
  });
});

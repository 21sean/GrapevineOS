/**
 * Durable LangGraph checkpointer backed by Supabase (PostgREST, not a raw
 * Postgres connection — the same transport everything else in this server
 * uses, so no DB password is needed and no pool is managed).
 *
 * Why not @langchain/langgraph-checkpoint-postgres: it needs a pg connection
 * string, and this deployment deliberately holds only the Supabase API key.
 * The storage model mirrors MemorySaver exactly — the whole checkpoint and
 * its metadata are serialized with the saver's JsonPlusSerializer (which
 * round-trips LangChain messages) and stored as base64 text, one row per
 * checkpoint plus one row per pending write.
 *
 * Failure posture: chat must survive the database not answering. Every method
 * catches, warns once, and degrades — getTuple to "no memory" (the HTTP layer
 * then reseeds from chat_messages), put/putWrites to a dropped checkpoint.
 * Durability degrades; the turn never fails.
 *
 * Growth is bounded twice: put() opportunistically prunes each thread down to
 * the newest KEEP_PER_THREAD checkpoints, and the retention sweep deletes
 * rows older than CHAT_CHECKPOINT_RETENTION_DAYS regardless of thread.
 */
import {
  BaseCheckpointSaver,
  TASKS,
  WRITES_IDX_MAP,
  getCheckpointId,
  copyCheckpoint,
  maxChannelVersion,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { db } from "./db.js";
import type { Tables } from "./db-types.js";
import { logger } from "./log.js";

const log = logger("checkpointer");

/** Newest checkpoints kept per thread; older supersteps are history nobody replays. */
const KEEP_PER_THREAD = 12;

/** How often put() bothers pruning (1-in-N). Cheap, but not free. */
const PRUNE_EVERY = 8;

let warned = false;
function warnOnce(op: string, err: unknown): void {
  if (warned) return;
  warned = true;
  log.warn(
    `${op} failed — chat memory degrades to per-process until the database answers: ${String(err).slice(0, 200)}`,
  );
}

function b64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

function unb64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

type CheckpointRow = Tables<"chat_checkpoints">;

export class SupabaseSaver extends BaseCheckpointSaver {
  private puts = 0;

  private async rowToTuple(row: CheckpointRow): Promise<CheckpointTuple> {
    const checkpoint = (await this.serde.loadsTyped(row.type, unb64(row.checkpoint))) as Checkpoint;
    const metadata = (await this.serde.loadsTyped(row.type, unb64(row.metadata))) as
      | CheckpointMetadata
      | undefined;

    const { data: writeRows } = await db
      .from("chat_checkpoint_writes")
      .select("task_id, idx, channel, type, value")
      .eq("thread_id", row.thread_id)
      .eq("checkpoint_ns", row.checkpoint_ns)
      .eq("checkpoint_id", row.checkpoint_id)
      .order("idx", { ascending: true })
      .throwOnError();
    const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
      writeRows.map(
        async (w) =>
          [w.task_id, w.channel, await this.serde.loadsTyped(w.type, unb64(w.value))] as CheckpointPendingWrite,
      ),
    );

    // Pre-v4 checkpoints migrate pending sends from the parent's writes; this
    // table never held any (it was born on v4), but stay faithful anyway.
    if (checkpoint.v < 4 && row.parent_id) {
      const { data: sends } = await db
        .from("chat_checkpoint_writes")
        .select("type, value")
        .eq("thread_id", row.thread_id)
        .eq("checkpoint_ns", row.checkpoint_ns)
        .eq("checkpoint_id", row.parent_id)
        .eq("channel", TASKS)
        .order("idx", { ascending: true })
        .throwOnError();
      checkpoint.channel_values ??= {};
      checkpoint.channel_values[TASKS] = await Promise.all(
        sends.map((s) => this.serde.loadsTyped(s.type, unb64(s.value))),
      );
      checkpoint.channel_versions ??= {};
      checkpoint.channel_versions[TASKS] =
        Object.keys(checkpoint.channel_versions).length > 0
          ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
          : this.getNextVersion(undefined);
    }

    return {
      config: {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
      ...(row.parent_id && {
        parentConfig: {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.parent_id,
          },
        },
      }),
    };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (!threadId) return undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const checkpointId = getCheckpointId(config);
    try {
      let query = db
        .from("chat_checkpoints")
        .select("*")
        .eq("thread_id", threadId)
        .eq("checkpoint_ns", ns);
      if (checkpointId) query = query.eq("checkpoint_id", checkpointId);
      const { data } = await query
        // uuid6 ids sort lexicographically in time order — newest first.
        .order("checkpoint_id", { ascending: false })
        .limit(1)
        .maybeSingle()
        .throwOnError();
      if (!data) return undefined;
      return await this.rowToTuple(data);
    } catch (err) {
      warnOnce("getTuple", err);
      return undefined;
    }
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = config.configurable?.thread_id as string | undefined;
    if (!threadId) return;
    const ns = config.configurable?.checkpoint_ns as string | undefined;
    const before = options?.before?.configurable?.checkpoint_id as string | undefined;
    try {
      let query = db.from("chat_checkpoints").select("*").eq("thread_id", threadId);
      if (ns !== undefined) query = query.eq("checkpoint_ns", ns);
      if (before) query = query.lt("checkpoint_id", before);
      const { data } = await query
        .order("checkpoint_id", { ascending: false })
        .limit(Math.min(options?.limit ?? 100, 500))
        .throwOnError();
      for (const row of data) {
        const tuple = await this.rowToTuple(row);
        if (
          options?.filter &&
          !Object.entries(options.filter).every(
            ([k, v]) => (tuple.metadata as Record<string, unknown> | undefined)?.[k] === v,
          )
        ) {
          continue;
        }
        yield tuple;
      }
    } catch (err) {
      warnOnce("list", err);
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    if (!threadId) throw new Error("put: missing thread_id in config.configurable");
    const next: RunnableConfig = {
      configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id },
    };
    try {
      const [[type, serialized], [, serializedMetadata]] = await Promise.all([
        this.serde.dumpsTyped(copyCheckpoint(checkpoint)),
        this.serde.dumpsTyped(metadata),
      ]);
      await db
        .from("chat_checkpoints")
        .upsert({
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: checkpoint.id,
          parent_id: (config.configurable?.checkpoint_id as string | undefined) ?? null,
          type,
          checkpoint: b64(serialized),
          metadata: b64(serializedMetadata),
        })
        .throwOnError();
      if (++this.puts % PRUNE_EVERY === 0) void this.pruneThread(threadId, ns);
    } catch (err) {
      warnOnce("put", err);
    }
    return next;
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = config.configurable?.thread_id as string | undefined;
    const ns = (config.configurable?.checkpoint_ns as string | undefined) ?? "";
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    if (!threadId || !checkpointId || !writes.length) return;
    try {
      const rows = await Promise.all(
        writes.map(async ([channel, value], i) => {
          const [type, serialized] = await this.serde.dumpsTyped(value);
          return {
            thread_id: threadId,
            checkpoint_ns: ns,
            checkpoint_id: checkpointId,
            task_id: taskId,
            // Special channels (errors, interrupts) get fixed negative slots
            // and overwrite; ordinary writes keep their first-written value.
            idx: WRITES_IDX_MAP[channel] ?? i,
            channel,
            type,
            value: b64(serialized),
          };
        }),
      );
      const special = rows.filter((r) => r.idx < 0);
      const ordinary = rows.filter((r) => r.idx >= 0);
      if (special.length) {
        await db.from("chat_checkpoint_writes").upsert(special).throwOnError();
      }
      if (ordinary.length) {
        await db
          .from("chat_checkpoint_writes")
          .upsert(ordinary, { ignoreDuplicates: true })
          .throwOnError();
      }
    } catch (err) {
      warnOnce("putWrites", err);
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    try {
      await Promise.all([
        db.from("chat_checkpoints").delete().eq("thread_id", threadId).throwOnError(),
        db.from("chat_checkpoint_writes").delete().eq("thread_id", threadId).throwOnError(),
      ]);
    } catch (err) {
      warnOnce("deleteThread", err);
    }
  }

  /** Drop everything but the newest KEEP_PER_THREAD checkpoints of one thread. */
  private async pruneThread(threadId: string, ns: string): Promise<void> {
    try {
      const { data } = await db
        .from("chat_checkpoints")
        .select("checkpoint_id")
        .eq("thread_id", threadId)
        .eq("checkpoint_ns", ns)
        .order("checkpoint_id", { ascending: false })
        .range(KEEP_PER_THREAD, KEEP_PER_THREAD + 200)
        .throwOnError();
      const stale = data.map((r) => r.checkpoint_id);
      if (!stale.length) return;
      await Promise.all([
        db
          .from("chat_checkpoints")
          .delete()
          .eq("thread_id", threadId)
          .eq("checkpoint_ns", ns)
          .in("checkpoint_id", stale)
          .throwOnError(),
        db
          .from("chat_checkpoint_writes")
          .delete()
          .eq("thread_id", threadId)
          .eq("checkpoint_ns", ns)
          .in("checkpoint_id", stale)
          .throwOnError(),
      ]);
    } catch {
      /* pruning is best-effort; the retention sweep is the backstop */
    }
  }
}

/**
 * Retention backstop for the sweep in retention.ts: checkpoints are runtime
 * state, not the record (chat_messages is), so anything old is deletable.
 */
export async function pruneChatCheckpoints(cutoff: Date): Promise<number> {
  const iso = cutoff.toISOString();
  const { count } = await db
    .from("chat_checkpoints")
    .delete({ count: "exact" })
    .lt("at", iso)
    .throwOnError();
  await db.from("chat_checkpoint_writes").delete().lt("at", iso).throwOnError();
  return count ?? 0;
}

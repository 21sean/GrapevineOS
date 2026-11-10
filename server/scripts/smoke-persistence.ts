import assert from "node:assert/strict";
import { HumanMessage } from "@langchain/core/messages";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { SupabaseSaver } from "../src/checkpointer.js";

const [phase, threadId] = process.argv.slice(2);
const url = new URL(process.env.SUPABASE_URL ?? "http://invalid");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Local database required");
assert.match(threadId ?? "", /^setup-smoke-[a-f0-9-]+$/);
const saver = new SupabaseSaver();
const config = { configurable: { thread_id: threadId, checkpoint_ns: "" } };

if (phase === "write") {
  const checkpoint = emptyCheckpoint();
  checkpoint.channel_values = { messages: [new HumanMessage("Remember this smoke test")] };
  const saved = await saver.put(config, checkpoint, { source: "input", step: 0, parents: {} }, {});
  await saver.putWrites(saved, [["smoke", "persisted"]], "smoke-task");
  assert.ok(await saver.getTuple(config), "Checkpoint write failed");
} else if (phase === "read") {
  const tuple = await saver.getTuple(config);
  assert.ok(tuple, "A new process could not load the saved checkpoint");
  const messages = tuple.checkpoint.channel_values.messages as HumanMessage[];
  assert.equal(messages[0].content, "Remember this smoke test");
  assert.deepEqual(tuple.pendingWrites, [["smoke-task", "smoke", "persisted"]]);
} else if (phase === "clean") {
  await saver.deleteThread(threadId);
  assert.equal(await saver.getTuple(config), undefined);
} else {
  throw new Error("Expected write, read or clean");
}
console.log(`Checkpoint ${phase}: passed`);

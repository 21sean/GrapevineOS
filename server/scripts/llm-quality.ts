import "../src/offline.js";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { LLMTestCase } from "deepeval/test-case";
import { eval_reportSchema, goldenSchema } from "../src/llm/generated.js";
import { GatedMetric } from "../src/evals/gated-metric.js";
import { judge } from "../src/evals/judge.js";
import { stopGate } from "../src/llm/gateway.js";

/**
 * One whole tool round through the real graph, gate and model: the model asks for a
 * tool, the result goes back, and the answer uses it. The web and the writes are
 * fixtures, and this process has no database.
 */
async function liveToolRound(j: { name: string; baseUrl: string }) {
  process.env.SUPABASE_URL ??= "https://live-quality.invalid";
  process.env.SUPABASE_SECRET_KEY ??= "live-quality-placeholder";
  process.env.MAPBOX_SECRET_TOKEN ??= "live-quality-placeholder";
  process.env.GUARDRAILS = "off";
  const { TASKS, runInjectionCase } = await import("../src/evals/injection.js");
  const task = TASKS.find((t) => t.id === "page-parking");
  if (!task) return { ok: false, why: "no such task" };
  const row = await runInjectionCase(task, null, null, { model: j.name, baseUrl: j.baseUrl });
  if (row.error) return { ok: false, why: row.error };
  if (!row.calls.some((c) => c.name === "read_page")) return { ok: false, why: "no tool call" };
  if (!row.utility) return { ok: false, why: `the answer did not use the result: ${row.answer}` };
  return { ok: true, why: "" };
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const mode = process.argv.includes("--live") ? "live" : "replay";
const output = `${root}/llm/artifacts/${mode}.json`;
const python =
  process.env.GRAPEVINE_LLM_PYTHON ||
  `${root}/llm/.venv/${process.platform === "win32" ? "Scripts/python.exe" : "bin/python"}`;
const child = spawnSync(python, ["-m", "grapevine_llm.evals", "--mode", mode, "--output", output], {
  cwd: `${root}/llm`,
  stdio: "inherit",
  windowsHide: true,
});
if (child.status !== 0) process.exit(child.status ?? 1);
const report = eval_reportSchema.parse(JSON.parse(await readFile(output, "utf8")));
const cases = (await readFile(`${root}/llm/evals/golden.jsonl`, "utf8"))
  .trim()
  .split(/\r?\n/)
  .map((line) => goldenSchema.parse(JSON.parse(line)));
let toolRound = { ok: true, why: "" };
try {
  if (mode === "live") {
    const j = await judge();
    for (const result of report.results) {
      const c = cases.find((c) => c.id === result.id);
      if (!c) throw new Error(`Unrecognized case: ${result.id}`);
      if (!result.passed || !c.rubric || !result.output_json) continue;
      const rubrics = [c.rubric];
      if (c.request.task === "agent")
        rubrics.push(
          "Groundedness: every factual claim in the answer is supported by the supplied evidence. Unsupported or contradictory details score zero.",
          "Relevance: the answer directly addresses the user's request and constraints, without irrelevant filler.",
        );
      const scores: number[] = [],
        reasons: string[] = [];
      for (const criteria of rubrics) {
        const metric = new GatedMetric({
          name: "Golden quality",
          criteria,
          model: j.model,
          threshold: 0.75,
        });
        scores.push(
          await metric.measure(
            new LLMTestCase({
              input: c.request.messages
                .filter((m) => m.role === "user")
                .map((m) => m.content)
                .join("\n"),
              actualOutput: result.output_json,
              retrievalContext: c.request.context?.evidence?.map((e) => e.text) ?? [],
            }),
          ),
        );
        reasons.push(metric.reason || "");
      }
      result.judge_score = Math.min(...scores);
      result.judge_reason = reasons.join("\n");
      result.passed = result.judge_score >= 0.75;
      if (!result.passed) result.reason = "subjective quality below threshold";
    }
    toolRound = await liveToolRound(j);
    console.log(`Live tool round: ${toolRound.ok ? "pass" : `fail: ${toolRound.why}`}`);
  }
  // Golden cases are single generations, so this is what proves a tool result gets back
  // to the model. Every tool turn was broken on main with all 15 of them green.
  report.passed = report.results.every((r) => r.passed) && toolRound.ok;
} catch (error) {
  report.passed = false;
  console.error(error);
} finally {
  stopGate();
  await writeFile(output, JSON.stringify(eval_reportSchema.parse(report), null, 2) + "\n");
}
console.log(`DeepEval local quality: ${report.passed ? "pass" : "fail"}`);
if (!report.passed) process.exitCode = 1;

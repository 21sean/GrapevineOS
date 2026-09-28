/**
 * Score the input rail against the labelled corpus and print the table.
 *
 *   npm --prefix server run guardrails:calibrate
 *
 * The same numbers the calibration eval suite asserts on, printed in full:
 * per-family recall, the confusion matrix at the configured threshold, the
 * dead band, and what the best threshold would have been. Run it after
 * changing GUARD_MODEL, after adding corpus entries, or when deciding what to
 * move the threshold to.
 *
 * `--json` prints the raw scores instead, for pasting into a diff.
 */
import "dotenv/config";
import { scanText } from "../src/agent/guardrails.js";
import { CORPUS, SCOPE_RULE } from "../src/evals/corpus.js";
import {
  auc,
  bestThresholds,
  byFamily,
  confusionAt,
  deadBand,
  inScope,
  pct,
  type Scored,
} from "../src/evals/calibration.js";

const json = process.argv.includes("--json");
const threshold = Number(process.env.GUARD_THRESHOLD ?? 0.8);

async function main() {
  const scored: Scored[] = [];
  for (const entry of CORPUS) {
    // record:false: corpus scans are synthetic and must never enter the
    // distribution the panel reports on.
    const v = await scanText(entry.text, { record: false });
    if (!v.available) {
      console.error(
        "The classifier did not load, so every score would be a placeholder. Check the model download and try again.",
      );
      process.exit(1);
    }
    scored.push({ entry, score: v.score });
    if (!json) process.stderr.write(".");
  }
  if (!json) process.stderr.write("\n\n");

  if (json) {
    console.log(
      JSON.stringify(
        scored.map((s) => ({
          id: s.entry.id,
          family: s.entry.family,
          attack: s.entry.attack,
          scope: s.entry.scope,
          score: Number(s.score.toFixed(4)),
        })),
        null,
        2,
      ),
    );
    return;
  }

  const graded = inScope(scored);
  const at = confusionAt(graded, threshold);
  const area = auc(graded);
  const { bestF1, cleanest } = bestThresholds(graded);
  const attacks = scored.filter((s) => s.entry.attack);
  const out = attacks.filter((s) => s.entry.scope === "out");

  console.log(
    `corpus: ${CORPUS.length} entries — ${attacks.length} attacks (${attacks.length - out.length} in scope, ${out.length} out), ${scored.length - attacks.length} benign`,
  );
  console.log(`scope rule: ${SCOPE_RULE}`);
  console.log("");
  console.log(
    `AUC (in scope): ${area === null ? "n/a" : area.toFixed(4)}   threshold-independent separation`,
  );
  console.log("");

  console.log(`at the configured threshold ${threshold.toFixed(2)}:`);
  console.log(
    `  recall    ${pct(at.recall)}  (${at.truePositives}/${at.truePositives + at.falseNegatives} in-scope attacks caught)`,
  );
  console.log(`  precision ${pct(at.precision)}`);
  console.log(
    `  false positives ${at.falsePositives}/${at.falsePositives + at.trueNegatives} benign  (${pct(at.falsePositiveRate)})`,
  );
  console.log("");

  console.log("by attack family (in-scope recall; out-of-scope shown for context):");
  for (const f of byFamily(scored, threshold).sort((a, b) => b.recall - a.recall)) {
    const flag = f.inScope === 0 ? "n/a " : f.recall >= 0.75 ? "ok  " : "WEAK";
    const outNote = f.outOfScope ? `  +${f.outOfScopeDetected}/${f.outOfScope} out-of-scope` : "";
    console.log(
      `  ${flag} ${f.family.padEnd(20)} ${String(f.inScopeDetected).padStart(2)}/${String(f.inScope).padEnd(2)} caught  scores ${f.minScore.toFixed(3)}-${f.maxScore.toFixed(3)}${outNote}`,
    );
  }
  console.log("");

  const band = deadBand(graded);
  if (band && band.width > 0.05) {
    console.log(
      `dead band: no entry scores between ${band.lo.toFixed(3)} and ${band.hi.toFixed(3)} (${band.width.toFixed(3)} wide).`,
    );
    console.log(
      `  Any threshold in that range behaves identically. Tuning inside it changes nothing,`,
    );
    console.log(`  which is worth knowing before spending an afternoon on it.`);
    console.log("");
  }

  if (cleanest) {
    console.log(
      `lowest threshold with zero false positives: ${cleanest.threshold.toFixed(3)} (recall ${pct(cleanest.recall)})`,
    );
  }
  if (bestF1) {
    console.log(
      `raw best F1 at ${bestF1.threshold.toFixed(3)}: F1 ${bestF1.f1.toFixed(3)}, ${bestF1.falsePositives} false positive(s) — reported, not recommended`,
    );
  }
  console.log("");

  const misses = graded
    .filter((s) => s.entry.attack && s.score < threshold)
    .sort((a, b) => b.score - a.score);
  if (misses.length) {
    console.log(`in-scope attacks under the threshold (${misses.length}) — real gaps:`);
    for (const m of misses) {
      console.log(
        `  ${m.score.toFixed(3)}  ${m.entry.family.padEnd(20)} ${m.entry.text.replace(/\s+/g, " ").slice(0, 68)}`,
      );
    }
    console.log("");
  }

  const fps = graded
    .filter((s) => !s.entry.attack && s.score >= threshold)
    .sort((a, b) => b.score - a.score);
  if (fps.length) {
    console.log(`benign over the threshold (${fps.length}) — these are the ones that matter:`);
    for (const f of fps) {
      console.log(`  ${f.score.toFixed(3)}  ${f.entry.text.replace(/\s+/g, " ").slice(0, 68)}`);
    }
  } else {
    console.log("no benign entry scored over the threshold.");
  }

  console.log("");
  console.log("closest benign entries to the threshold (the false-positive frontier):");
  for (const n of scored
    .filter((s) => !s.entry.attack)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)) {
    console.log(`  ${n.score.toFixed(3)}  ${n.entry.text.replace(/\s+/g, " ").slice(0, 68)}`);
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});

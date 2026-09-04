/**
 * How many real sources still carry schema.org/Event markup.
 *
 *   npx tsx scripts/jsonld-coverage.ts
 *
 * A measurement, not a gate. It hits the live web, so its answer moves when a
 * publisher redesigns or Cloudflare decides we look like a bot, and wiring
 * that into a pass/fail check would produce a suite that goes red for reasons
 * nobody can fix. The parser assertions that ARE a gate live in
 * src/evals/suites/jsonld.ts and run offline.
 *
 * This is the number that decides whether structured-first is worth keeping.
 */
import { extractJsonLdEvents } from "../src/jsonld.js";

const SOURCES = [
  "https://san-diego.events/august/",
  "https://www.songkick.com/metro-areas/11086-us-san-diego",
  "https://secretsandiego.com/things-to-to-do-this-august-2026-in-san-diego/",
  "https://sandiegomagazine.com/things-to-do/the-best-things-to-do-in-san-diego-august-2026/",
  "https://www.myguidesandiego.com/events/august-2026",
  "https://www.casbahmusic.com/calendar",
  "https://bellyup.com/events/",
  "https://www.observatorysd.com/northpark/",
];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

let withMarkup = 0;
console.log("live coverage:");
for (const url of SOURCES) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": UA },
    });
    if (!res.ok) {
      console.log(`  ${host.padEnd(24)} http ${res.status}`);
      continue;
    }
    const n = extractJsonLdEvents(await res.text(), url).length;
    if (n) withMarkup++;
    console.log(
      `  ${host.padEnd(24)} ${String(n).padStart(3)} events${n ? "  <- free, exact" : ""}`,
    );
  } catch (err) {
    console.log(`  ${host.padEnd(24)} ${String((err as Error)?.message ?? err).slice(0, 40)}`);
  }
}
console.log(`\n${withMarkup}/${SOURCES.length} sources carry usable schema.org/Event markup`);

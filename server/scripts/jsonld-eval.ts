/**
 * JSON-LD eval — parser unit cases plus a live coverage probe.
 *
 *   npx tsx scripts/jsonld-eval.ts          # offline parser cases only
 *   npx tsx scripts/jsonld-eval.ts --live   # also re-measure real sources
 *
 * The offline cases pin the shapes publishers actually emit: @graph wrappers,
 * ItemList nesting, fully-qualified keys, string-vs-object locations, offer
 * arrays, cancelled events. The --live probe answers a different question -
 * how many sources carry this markup at all - and is the number that decides
 * whether structured-first is worth keeping.
 */
import { extractJsonLdEvents } from "../src/jsonld.js";

const page = (ld: unknown) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>x</body></html>`;

let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

console.log("parser cases:");

// 1. the plain shape
{
  const [e] = extractJsonLdEvents(
    page({
      "@context": "https://schema.org",
      "@type": "MusicEvent",
      name: "Moonchild",
      startDate: "2026-08-02T20:00:00-07:00",
      endDate: "2026-08-02T23:00:00-07:00",
      location: { "@type": "Place", name: "Music Box", address: { "@type": "PostalAddress", streetAddress: "1337 India St", addressLocality: "San Diego" } },
      offers: { "@type": "Offer", price: "25", priceCurrency: "USD", url: "https://tickets.example/moonchild" },
    }),
    "https://src.example",
  );
  check("reads a plain MusicEvent", !!e && e.title === "Moonchild");
  check("maps @type to category", e?.category === "music", e?.category);
  check("keeps the exact start", e?.start === "2026-08-02T20:00:00-07:00");
  check("joins the postal address", e?.address === "1337 India St, San Diego", e?.address);
  check("reads the offer price", e?.price === "$25", e?.price);
  check("reads the ticket url", e?.ticketUrl === "https://tickets.example/moonchild");
}

// 2. @graph wrapper, the most common CMS output
{
  const events = extractJsonLdEvents(
    page({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Organization", name: "Not an event" },
        { "@type": "Event", name: "Block Party", startDate: "2026-08-09", location: "5th Ave" },
      ],
    }),
    "https://src.example",
  );
  check("finds events inside @graph", events.length === 1 && events[0].title === "Block Party");
  check("date-only start becomes local midnight", events[0]?.start === "2026-08-09T00:00:00", events[0]?.start);
  check("string location works", events[0]?.venue === "5th Ave");
}

// 3. ItemList nesting
{
  const events = extractJsonLdEvents(
    page({
      "@type": "ItemList",
      itemListElement: [
        { "@type": "ListItem", item: { "@type": "Festival", name: "Tiki Oasis", startDate: "2026-08-05T12:00:00-07:00", location: { name: "Town and Country" } } },
      ],
    }),
    "https://src.example",
  );
  check("finds events inside ItemList", events.length === 1 && events[0].title === "Tiki Oasis");
  check("Festival maps to festival", events[0]?.category === "festival");
}

// 4. fully-qualified keys — the case a real JSON-LD processor would handle
{
  const [e] = extractJsonLdEvents(
    page({
      "@type": "http://schema.org/Event",
      "http://schema.org/name": "Expanded IRI Show",
      "http://schema.org/startDate": "2026-08-10T19:00:00-07:00",
      "http://schema.org/location": { "http://schema.org/name": "The Casbah" },
    }),
    "https://src.example",
  );
  check("handles fully-qualified keys and types", !!e && e.title === "Expanded IRI Show" && e.venue === "The Casbah");
}

// 5. offers array — cheapest wins, marked as a floor
{
  const [e] = extractJsonLdEvents(
    page({ "@type": "Event", name: "Tiered", startDate: "2026-08-11T19:00:00-07:00", location: { name: "V" }, offers: [{ price: "45" }, { price: "20" }] }),
    "https://src.example",
  );
  check("cheapest offer wins, marked +", e?.price === "$20+", e?.price);
}

// 6. free events
{
  const [e] = extractJsonLdEvents(
    page({ "@type": "Event", name: "Free Show", startDate: "2026-08-11T19:00:00-07:00", location: { name: "V" }, offers: { price: "0" } }),
    "https://src.example",
  );
  check("price 0 becomes Free", e?.price === "Free" && e?.free === true);
}

// 7. things that must NOT become events
{
  check(
    "cancelled events are dropped",
    extractJsonLdEvents(page({ "@type": "Event", name: "Off", startDate: "2026-08-11T19:00:00-07:00", location: { name: "V" }, eventStatus: "https://schema.org/EventCancelled" }), "u").length === 0,
  );
  check(
    "an event with no date is dropped",
    extractJsonLdEvents(page({ "@type": "Event", name: "Someday", location: { name: "V" } }), "u").length === 0,
  );
  check(
    "non-event types are ignored",
    extractJsonLdEvents(page({ "@type": "Product", name: "T-shirt", startDate: "2026-08-11" }), "u").length === 0,
  );
  check("malformed JSON does not throw", extractJsonLdEvents('<script type="application/ld+json">{oops</script>', "u").length === 0);
  check("a page with no markup yields nothing", extractJsonLdEvents("<html><body>hi</body></html>", "u").length === 0);
  check(
    "Null Island coordinates are rejected",
    extractJsonLdEvents(page({ "@type": "Event", name: "N", startDate: "2026-08-11T19:00:00-07:00", location: { name: "V", geo: { latitude: 0, longitude: 0 } } }), "u")[0]?.lat === undefined,
  );
}

// 8. the precision signal that decides structured-vs-prose routing
{
  const one = (ld: object) => extractJsonLdEvents(page({ "@type": "Event", location: { name: "V" }, ...ld }), "u")[0];
  check(
    "a start with a clock time is precise",
    one({ name: "A", startDate: "2026-08-11T19:30:00-07:00" })?.precise === true,
  );
  check(
    "a single-day date-only start is NOT precise",
    one({ name: "B", startDate: "2026-08-11" })?.precise === false,
  );
  check(
    "a multi-day run is precise even without a clock",
    one({ name: "C", startDate: "2026-08-05", endDate: "2026-08-09" })?.precise === true,
  );
}

// 9. de-duplication of the same event repeated across blocks
{
  const html = `<html><head>
    <script type="application/ld+json">${JSON.stringify({ "@type": "Event", name: "Twice", startDate: "2026-08-12T19:00:00-07:00", location: { name: "V" } })}</script>
    <script type="application/ld+json">${JSON.stringify({ "@graph": [{ "@type": "Event", name: "Twice", startDate: "2026-08-12T19:00:00-07:00", location: { name: "V" } }] })}</script>
  </head><body>x</body></html>`;
  check("same event in two blocks collapses", extractJsonLdEvents(html, "u").length === 1);
}

console.log(`\n${failed === 0 ? "all parser cases passed" : `${failed} FAILED`}`);

if (process.argv.includes("--live")) {
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
  console.log("\nlive coverage:");
  let withMarkup = 0;
  for (const url of SOURCES) {
    const host = new URL(url).hostname.replace(/^www\./, "");
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" },
      });
      if (!res.ok) {
        console.log(`  ${host.padEnd(24)} http ${res.status}`);
        continue;
      }
      const html = await res.text();
      const n = extractJsonLdEvents(html, url).length;
      if (n) withMarkup++;
      console.log(`  ${host.padEnd(24)} ${String(n).padStart(3)} events${n ? "  ← free, exact" : ""}`);
    } catch (err) {
      console.log(`  ${host.padEnd(24)} ${String((err as Error)?.message ?? err).slice(0, 40)}`);
    }
  }
  console.log(`\n${withMarkup}/${SOURCES.length} sources carry usable schema.org/Event markup`);
}

process.exit(failed ? 1 : 0);

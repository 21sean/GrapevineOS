/**
 * schema.org/Event extraction — the structured-first path in discovery.
 *
 * When a page carries this markup we take the publisher's own dates and prices
 * instead of asking a model to read prose, which is both free and exact. That
 * makes the parser the highest-leverage code in ingestion and the easiest to
 * regress, because publishers emit every shape in the spec and several that
 * are not: @graph wrappers, ItemList nesting, fully-qualified IRIs, offers as
 * arrays, and cancelled events that still sit in the markup.
 *
 * The negative cases carry the most weight. Anything this parser accepts goes
 * on the map without a model ever seeing it.
 */
import { extractJsonLdEvents } from "../../jsonld.js";
import { expect, expectEq, type EvalSuite } from "../harness.js";

const page = (ld: unknown) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>x</body></html>`;

const SRC = "https://src.example";

export const jsonldSuite: EvalSuite = {
  id: "jsonld",
  title: "schema.org extraction",
  what: "Publisher markup becomes exact events, and non-events never become events.",
  kind: "offline",
  threshold: 1,
  cases: () => [
    {
      id: "plain-event",
      name: "A plain MusicEvent, read whole",
      note: "Title, type mapping, exact start, joined address, offer price, ticket URL.",
      run: () => {
        const [e] = extractJsonLdEvents(
          page({
            "@context": "https://schema.org",
            "@type": "MusicEvent",
            name: "Moonchild",
            startDate: "2026-08-02T20:00:00-07:00",
            endDate: "2026-08-02T23:00:00-07:00",
            location: {
              "@type": "Place",
              name: "Music Box",
              address: { "@type": "PostalAddress", streetAddress: "1337 India St", addressLocality: "San Diego" },
            },
            offers: { "@type": "Offer", price: "25", priceCurrency: "USD", url: "https://tickets.example/moonchild" },
          }),
          SRC,
        );
        expect(e, "no event extracted");
        expectEq(e.title, "Moonchild", "title");
        expectEq(e.category, "music", "MusicEvent maps to");
        expectEq(e.start, "2026-08-02T20:00:00-07:00", "start kept verbatim");
        expectEq(e.address, "1337 India St, San Diego", "joined postal address");
        expectEq(e.price, "$25", "offer price");
        expectEq(e.ticketUrl, "https://tickets.example/moonchild", "ticket url");
        return "6 fields read exactly";
      },
    },
    {
      id: "graph-wrapper",
      name: "Events inside an @graph wrapper",
      note: "The most common CMS output, and it buries the event next to unrelated nodes.",
      run: () => {
        const events = extractJsonLdEvents(
          page({
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "Organization", name: "Not an event" },
              { "@type": "Event", name: "Block Party", startDate: "2026-08-09", location: "5th Ave" },
            ],
          }),
          SRC,
        );
        expectEq(events.length, 1, "events found");
        expectEq(events[0].title, "Block Party", "title");
        expectEq(events[0].start, "2026-08-09T00:00:00", "date-only start becomes local midnight");
        expectEq(events[0].venue, "5th Ave", "a string location still works");
        return "1 event, organization ignored";
      },
    },
    {
      id: "itemlist-nesting",
      name: "Events inside an ItemList",
      run: () => {
        const events = extractJsonLdEvents(
          page({
            "@type": "ItemList",
            itemListElement: [
              {
                "@type": "ListItem",
                item: {
                  "@type": "Festival",
                  name: "Tiki Oasis",
                  startDate: "2026-08-05T12:00:00-07:00",
                  location: { name: "Town and Country" },
                },
              },
            ],
          }),
          SRC,
        );
        expectEq(events.length, 1, "events found");
        expectEq(events[0].title, "Tiki Oasis", "title");
        expectEq(events[0].category, "festival", "Festival maps to");
        return "unwrapped through ListItem";
      },
    },
    {
      id: "expanded-iris",
      name: "Fully-qualified IRIs for types and keys",
      note: "What a real JSON-LD processor emits, and what a naive key lookup misses.",
      run: () => {
        const [e] = extractJsonLdEvents(
          page({
            "@type": "http://schema.org/Event",
            "http://schema.org/name": "Expanded IRI Show",
            "http://schema.org/startDate": "2026-08-10T19:00:00-07:00",
            "http://schema.org/location": { "http://schema.org/name": "The Casbah" },
          }),
          SRC,
        );
        expect(e, "no event extracted from expanded IRIs");
        expectEq(e.title, "Expanded IRI Show", "title");
        expectEq(e.venue, "The Casbah", "venue");
        return "expanded keys resolved";
      },
    },
    {
      id: "offer-arrays",
      name: "Tiered offers: the cheapest wins and is marked a floor",
      note: 'Showing the top tier would price a $20 show at $45; showing $20 flat would lie the other way.',
      run: () => {
        const [e] = extractJsonLdEvents(
          page({
            "@type": "Event",
            name: "Tiered",
            startDate: "2026-08-11T19:00:00-07:00",
            location: { name: "V" },
            offers: [{ price: "45" }, { price: "20" }],
          }),
          SRC,
        );
        expectEq(e?.price, "$20+", "price");
        return "cheapest tier, marked as a floor";
      },
    },
    {
      id: "free-events",
      name: "A zero price becomes Free",
      run: () => {
        const [e] = extractJsonLdEvents(
          page({ "@type": "Event", name: "Free Show", startDate: "2026-08-11T19:00:00-07:00", location: { name: "V" }, offers: { price: "0" } }),
          SRC,
        );
        expectEq(e?.price, "Free", "price label");
        expectEq(e?.free, true, "free flag");
        return "priced Free, flagged free";
      },
    },
    {
      id: "rejects-non-events",
      name: "Cancelled, undated, and non-event markup is dropped",
      note: "Everything this accepts reaches the map without a model ever seeing it.",
      run: () => {
        const cancelled = extractJsonLdEvents(
          page({ "@type": "Event", name: "Off", startDate: "2026-08-11T19:00:00-07:00", location: { name: "V" }, eventStatus: "https://schema.org/EventCancelled" }),
          "u",
        );
        expectEq(cancelled.length, 0, "cancelled events kept");
        expectEq(extractJsonLdEvents(page({ "@type": "Event", name: "Someday", location: { name: "V" } }), "u").length, 0, "undated events kept");
        expectEq(extractJsonLdEvents(page({ "@type": "Product", name: "T-shirt", startDate: "2026-08-11" }), "u").length, 0, "products kept");
        return "3 kinds of non-event rejected";
      },
    },
    {
      id: "survives-bad-input",
      name: "Malformed markup does not throw",
      note: "A publisher with a broken script tag must not take down the whole discovery run.",
      run: () => {
        expectEq(extractJsonLdEvents('<script type="application/ld+json">{oops</script>', "u").length, 0, "malformed JSON");
        expectEq(extractJsonLdEvents("<html><body>hi</body></html>", "u").length, 0, "no markup at all");
        return "both returned empty instead of throwing";
      },
    },
    {
      id: "rejects-null-island",
      name: "Null Island coordinates are rejected",
      note: "0,0 is the default a broken CMS emits, and it lands in the Gulf of Guinea.",
      run: () => {
        const [e] = extractJsonLdEvents(
          page({ "@type": "Event", name: "N", startDate: "2026-08-11T19:00:00-07:00", location: { name: "V", geo: { latitude: 0, longitude: 0 } } }),
          "u",
        );
        expectEq(e?.lat, undefined, "latitude");
        return "0,0 dropped, event kept for geocoding";
      },
    },
    {
      id: "precision-signal",
      name: "The precision signal that routes structured vs. prose",
      note: "A date with no clock time is a listing, not a start time — the model has to re-read those.",
      run: () => {
        const one = (ld: object) => extractJsonLdEvents(page({ "@type": "Event", location: { name: "V" }, ...ld }), "u")[0];
        expectEq(one({ name: "A", startDate: "2026-08-11T19:30:00-07:00" })?.precise, true, "start with a clock time");
        expectEq(one({ name: "B", startDate: "2026-08-11" })?.precise, false, "single-day date-only start");
        expectEq(one({ name: "C", startDate: "2026-08-05", endDate: "2026-08-09" })?.precise, true, "multi-day run without a clock");
        return "3 routing decisions";
      },
    },
    {
      id: "cross-block-dedupe",
      name: "The same event in two blocks collapses",
      note: "Sites routinely emit the page event twice, once bare and once inside @graph.",
      run: () => {
        const one = { "@type": "Event", name: "Twice", startDate: "2026-08-12T19:00:00-07:00", location: { name: "V" } };
        const html = `<html><head>
          <script type="application/ld+json">${JSON.stringify(one)}</script>
          <script type="application/ld+json">${JSON.stringify({ "@graph": [one] })}</script>
        </head><body>x</body></html>`;
        expectEq(extractJsonLdEvents(html, "u").length, 1, "events after two blocks");
        return "2 blocks, 1 event";
      },
    },
  ],
};

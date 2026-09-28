/**
 * The shared tail of every ingestion path. Email, manual paste, preview
 * commit, and web discovery all end the same way: write the events, log the
 * run, and kick off image enrichment for whatever was new. One implementation
 * keeps the four paths from drifting (and keeps "added" meaning the same
 * thing in every ingest log).
 */
import { enrichEventImages } from "./images.js";
import { notifyRareFinds } from "./push.js";
import { store } from "./store.js";
import type { CityEvent, IngestRecord } from "./types.js";

export async function commitIngest(opts: {
  events: CityEvent[];
  source: string;
  kind: IngestRecord["kind"];
  subject?: string;
  /** Raw candidate count when it differs from events.length (discovery
   * verifies before committing, so it extracted more than it writes). */
  extracted?: number;
}): Promise<{ added: CityEvent[]; ingest: IngestRecord }> {
  const added = await store.addEvents(opts.events);
  const ingest = await store.logIngest({
    source: opts.source,
    kind: opts.kind,
    subject: opts.subject,
    extracted: opts.extracted ?? opts.events.length,
    added: added.length,
    events: added.map((e) => ({ id: e.id, title: e.title, start: e.start })),
  });
  // Artwork pass runs after the response: decoration, not a gate.
  if (added.length) void enrichEventImages(added).catch(() => {});
  // Rare-find pushes too: opt-in subscribers hear about a matching rare
  // one-off the moment it lands, without holding the ingest response.
  if (added.length) void notifyRareFinds(added).catch(() => {});
  return { added, ingest };
}

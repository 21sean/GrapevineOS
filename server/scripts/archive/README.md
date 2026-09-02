# Archived scripts

Retired scripts, kept for provenance. Nothing here is wired to an npm script or
included in `tsc --noEmit`, and the relative imports are kept resolvable only so
a reader can follow them. Where one of these and the current code disagree, the
code wins. The same practice for documents lives in `docs/archive/`.

| Script | Retired | Superseded by |
|---|---|---|
| [seed-langfuse.ts](seed-langfuse.ts) | 2026-09-02 | `scripts/langfuse/` (`npm run lf:*`). Its prompts and score configs are in `foundation.ts`, its fixture datasets in `import-datasets.ts`, its experiment in `experiments.ts`. The trace backfill of one machine's chat history is not reproduced. |
| [normalise-otel-resource.ts](normalise-otel-resource.ts) | 2026-09-02 | Nothing: a one-off ClickHouse repair for spans emitted before resource auto-detection was turned off. Every emitter now declares its resource by hand. |

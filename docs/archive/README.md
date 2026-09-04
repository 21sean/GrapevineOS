# Archived working notes

Point-in-time documents, kept for provenance. They describe the repo as it
stood on the date each was written, so every file path, line number, and
"current state" claim inside them should be read as a snapshot, not as
guidance. Where these and the code disagree, the code wins.

| Document                                           | Written    | Why it is here                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md)                 | 2026-07-11 | A brief for redrawing `docs/images/*.png`. Its "delta vs. the current PNG" tables were written against the July diagrams and predate the guardrail-telemetry rails, the Postgres places cache, and the PyRIT red team, so it no longer describes the redraw that is actually owed. |
| [features-logic-audit.md](features-logic-audit.md) | 2026-07-12 | An audit of correctness and duplication findings. The substantive ones have since been fixed (ICS weekday resolution, `BYMONTHDAY` expansion, and others), and the line references have long since drifted.                                                                        |
| [ux-feature-ideas.md](ux-feature-ideas.md)         | 2026-07-12 | A feature backlog. Several entries have shipped, among them the near-me radius chip, the map layers control, rare-find alerts, the trip and day-plan builder, and in-app notification history.                                                                                     |

Current documentation lives one directory up: [setup.md](../setup.md) for
setup, deployment, and operations, and [mapbox-places.md](../mapbox-places.md)
for the venue-card data source. The [README](../../README.md) is the source of
truth for how the system works.

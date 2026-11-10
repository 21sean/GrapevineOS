import type { TablesInsert } from "../src/db-types.js";

export const DEMO_SOURCE = "grapevine-demo";

/** Fictional fixtures, anchored to the next UTC day so every run starts with future events. */
export function demoEvents(now = new Date()): TablesInsert<"events">[] {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid demo date");
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 20);
  const fixtures = [
    ["music", "Waterfront jazz", "Embarcadero", -117.173, 32.716],
    ["food", "Neighborhood tasting", "Little Italy", -117.168, 32.723],
    ["sports", "Harbor walking club", "Waterfront Park", -117.172, 32.721],
    ["arts", "Open-air sketching", "Balboa Park", -117.151, 32.731],
    ["market", "Makers market", "North Park", -117.13, 32.748],
    ["festival", "Community film evening", "Liberty Station", -117.213, 32.738],
    ["community", "Garden meetup", "South Park", -117.128, 32.729],
  ] as const;
  return fixtures.map(([category, title, venue, lng, lat], index) => ({
    id: `demo-${category}`,
    dedupe_key: `grapevine-demo-${category}`,
    title: `[Demo] ${title}`,
    description: "Fictional sample event for exploring Grapevine. This is not a real listing.",
    category,
    venue,
    lng,
    lat,
    starts_at: new Date(start + index * 86_400_000).toISOString(),
    ends_at: new Date(start + index * 86_400_000 + 7_200_000).toISOString(),
    source_id: DEMO_SOURCE,
    source_kind: "seed",
    tags: ["demo", category],
    is_free: index % 2 === 0,
    price: index % 2 === 0 ? "Free" : "$10 (sample)",
    rating: 4,
    rating_rationale: "Sample rating for the demo.",
    rarity: index === 5 ? "rare" : "common",
    promoted: false,
    recurrence: null,
    ticket_url: null,
    image_url: null,
  }));
}

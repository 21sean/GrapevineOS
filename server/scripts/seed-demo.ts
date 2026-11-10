import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/db-types.js";
import { DEMO_SOURCE, demoEvents } from "./demo-data.js";

const url = new URL(process.env.SUPABASE_URL ?? "http://invalid");
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  !["http:", "https:"].includes(url.protocol) ||
  process.env.NODE_ENV === "production" ||
  url.username ||
  url.password
) {
  throw new Error("Demo seeding is restricted to local development databases.");
}
const key = process.env.SUPABASE_SECRET_KEY;
if (!key) throw new Error("Run npm run setup to configure local Supabase first.");
const db = createClient<Database>(url.href, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
await db
  .from("sources")
  .upsert(
    { id: DEMO_SOURCE, name: "Grapevine demo (fictional)", kind: "demo", active: false },
    { onConflict: "id" },
  )
  .throwOnError();
// Keep existing city, model and provider choices. Demo setup never selects a model.
await db
  .from("app_settings")
  .upsert(
    {
      id: 1,
      city: "San Diego, CA",
      center_lng: -117.1611,
      center_lat: 32.7157,
      tz: "America/Los_Angeles",
      model: "",
    },
    { onConflict: "id", ignoreDuplicates: true },
  )
  .throwOnError();
const events = demoEvents();
await db.from("events").upsert(events, { onConflict: "id" }).throwOnError();
const { count } = await db
  .from("events")
  .select("id", { count: "exact", head: true })
  .eq("source_id", DEMO_SOURCE)
  .throwOnError();
if (count !== events.length)
  throw new Error(`Expected ${events.length} demo events, found ${count}.`);
console.log(
  `Ready: ${count} fictional demo events. Rerunning refreshes their dates without duplicating them.`,
);

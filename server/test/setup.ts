/**
 * The unit tests need no database, no model and no keys, but several modules
 * read the environment at import time (auth.ts refuses to load without a
 * Supabase URL). Placeholders keep those imports honest without granting
 * anything: nothing here can reach a real project.
 */
process.env.SUPABASE_URL ??= "https://test.supabase.co";
process.env.SUPABASE_SECRET_KEY ??= "test-placeholder";
process.env.MAPBOX_SECRET_TOKEN ??= "test-placeholder";
// The classifier must never download in a unit test.
process.env.GUARDRAILS = "off";
process.env.LOG_LEVEL ??= "silent";

/**
 * App settings and the newsletter sources list. Reading settings is public
 * (the map needs the city and center before anyone signs in); writing them
 * is admin-only. Failures fall through to the error handler.
 */
import { Router } from "express";
import { invalidateGuardConfig } from "../agent/guardrails.js";
import { requireAdmin } from "../auth.js";
import { inboxDomain } from "../inbox.js";
import { store } from "../store.js";
import { LLM_PROVIDERS } from "../types.js";

export const settings = Router();

function validTimeZone(tz: unknown): boolean {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validCenter(c: unknown): boolean {
  if (!Array.isArray(c) || c.length !== 2) return false;
  const [lng, lat] = c;
  return (
    Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90
  );
}

/** Ollama is usually on this machine, so only the scheme is checked. */
function validHttpUrl(u: unknown): boolean {
  if (typeof u !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(u).protocol);
  } catch {
    return false;
  }
}

settings.get("/api/settings", async (_req, res) => {
  // inboxDomain is deployment config (INBOX_DOMAIN), not a stored setting;
  // the client reads it here so the admin panels can show real addresses.
  res.json({ ...(await store.settings()), inboxDomain: inboxDomain() });
});

settings.put("/api/settings", requireAdmin, async (req, res) => {
  const { city, center, tz, model, ollamaUrl, chatProvider, extractProvider } = req.body ?? {};
  if (chatProvider !== undefined && !LLM_PROVIDERS.includes(chatProvider)) {
    return res.status(400).json({ error: "unknown chatProvider" });
  }
  if (extractProvider !== undefined && !LLM_PROVIDERS.includes(extractProvider)) {
    return res.status(400).json({ error: "unknown extractProvider" });
  }
  if (tz !== undefined && !validTimeZone(tz)) {
    return res
      .status(400)
      .json({ error: "tz must be an IANA time zone, e.g. America/Los_Angeles" });
  }
  if (center !== undefined && !validCenter(center)) {
    return res.status(400).json({ error: "center must be [lng, lat]" });
  }
  if (ollamaUrl !== undefined && !validHttpUrl(ollamaUrl)) {
    return res.status(400).json({ error: "ollamaUrl must be an http(s) URL" });
  }
  if (city !== undefined && (typeof city !== "string" || !city.trim())) {
    return res.status(400).json({ error: "city must be a non-empty string" });
  }
  if (model !== undefined && typeof model !== "string") {
    return res.status(400).json({ error: "model must be a string" });
  }
  const saved = await store.saveSettings({
    ...(city !== undefined && { city }),
    ...(center !== undefined && { center }),
    ...(tz !== undefined && { tz }),
    ...(model !== undefined && { model }),
    ...(ollamaUrl !== undefined && { ollamaUrl }),
    ...(chatProvider !== undefined && { chatProvider }),
    ...(extractProvider !== undefined && { extractProvider }),
  });
  // The rails cache mode/threshold for a few seconds; a save from any
  // settings surface has to drop that cache or the retune appears to have
  // been ignored. (Admin, Guardrails does this for its own writes too.)
  invalidateGuardConfig();
  res.json({ ...saved, inboxDomain: inboxDomain() });
});

settings.get("/api/sources", async (_req, res) => {
  res.json(await store.sources());
});

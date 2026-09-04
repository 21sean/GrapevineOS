/**
 * Watches: the scheduled web-discovery searches a signed-in user owns. The
 * agent proposes one (propose_watch), the card in the chat confirms it here,
 * and the account dialog lists, pauses and deletes them. Same rows and same
 * scheduler as the operator's searches in Admin, Discover; the difference is
 * the owner and the cap.
 */
import { Router } from "express";
import { parseArgs } from "../agent/contracts.js";
import { sessionUser } from "../auth.js";
import { clampCadence } from "../discovery.js";
import { store } from "../store.js";

export const watches = Router();

/**
 * How many watches one account may keep: each is a recurring web crawl plus
 * model passes on the shared GPU, and five topics is a lot of watching.
 */
export const MAX_WATCHES_PER_USER = 5;

watches.get("/api/me/watches", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  res.json({
    watches: await store.discoverySearches({ userId: user.id }),
    max: MAX_WATCHES_PER_USER,
  });
});

watches.post("/api/me/watches", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const parsed = parseArgs("schedule_search", req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const result = await store.addWatch(
    user.id,
    parsed.args.query,
    clampCadence(parsed.args.cadence_hours),
    MAX_WATCHES_PER_USER,
  );
  if ("error" in result) return res.status(result.code).json({ error: result.error });
  res.status(201).json(result.watch);
});

watches.patch("/api/me/watches/:id", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const parsed = parseArgs("update_scheduled_search", { ...(req.body ?? {}), id: req.params.id });
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const { active, cadence_hours } = parsed.args;
  if (active === undefined && cadence_hours === undefined) {
    return res.status(400).json({ error: "nothing to update (active, cadence_hours)" });
  }
  const updated = await store.updateDiscoverySearch(
    parsed.args.id,
    {
      ...(active !== undefined && { active }),
      ...(cadence_hours !== undefined && { cadenceHours: clampCadence(cadence_hours) }),
    },
    user.id,
  );
  if (!updated) return res.status(404).json({ error: "not one of your watches" });
  res.json(updated);
});

watches.delete("/api/me/watches/:id", async (req, res) => {
  const user = await sessionUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const deleted = await store.deleteDiscoverySearch(String(req.params.id), user.id);
  if (!deleted) return res.status(404).json({ error: "not one of your watches" });
  res.json({ ok: true });
});

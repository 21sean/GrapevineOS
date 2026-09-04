/**
 * Admin, Inbox: the raw emails the worker wrote to Postgres and their
 * pipeline status, plus a manual re-run. Admin-only: the list shows who
 * emails the operator, and a reprocess spends a model call.
 */
import { Router } from "express";
import { requireAdmin } from "../auth.js";
import { listInbox, reprocessInbox } from "../inbox.js";

export const inbox = Router();

inbox.get("/api/inbox", requireAdmin, async (_req, res) => {
  try {
    res.json(await listInbox());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

inbox.post("/api/inbox/reprocess", requireAdmin, async (req, res) => {
  const key = String(req.body?.key ?? "");
  if (!key) return res.status(400).json({ error: "key required" });
  try {
    res.json(await reprocessInbox(key));
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

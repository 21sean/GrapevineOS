/**
 * Small in-process limits for the routes that cost money or GPU time: chat
 * turns, Mapbox directions and isochrones, and Places lookups against a
 * 1,000-record monthly preview quota.
 *
 * No dependency and no shared store on purpose. This is one process with one
 * map that is wiped on restart; a limiter that survived restarts or spanned
 * replicas would be a different design for a different deployment. Behind a
 * tunnel or reverse proxy `trust proxy` is on, so req.ip is the client rather
 * than the proxy.
 */
import type { NextFunction, Request, Response } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

/** Fixed-window count per client address. Standard RateLimit-* headers on every reply. */
export function rateLimit(opts: { name: string; windowMs: number; max: number }) {
  const buckets = new Map<string, Bucket>();
  let sweepAt = Date.now() + opts.windowMs;
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    if (now >= sweepAt) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
      sweepAt = now + opts.windowMs;
    }
    const key = req.ip ?? "unknown";
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    res.setHeader("RateLimit-Limit", String(opts.max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, opts.max - bucket.count)));
    if (bucket.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ error: `too many ${opts.name} requests; try again in a moment` });
      return;
    }
    next();
  };
}

/**
 * One in-flight request per key. A second chat stream from the same account
 * (or the same address when signed out) gets a 429 instead of a second GPU
 * job. Released when the response closes, however it closes.
 */
export function singleFlight(opts: {
  name: string;
  key: (req: Request) => Promise<string> | string;
}) {
  const active = new Set<string>();
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = await opts.key(req);
    if (active.has(key)) {
      res.status(429).json({ error: `one ${opts.name} at a time` });
      return;
    }
    active.add(key);
    res.once("close", () => active.delete(key));
    next();
  };
}

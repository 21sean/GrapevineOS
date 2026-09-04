/**
 * Request ids, the access log, and the two handlers every route falls
 * through to.
 *
 * The id is minted here (or taken from an X-Request-Id the proxy set),
 * returned on every response, stamped into the Langfuse trace of a chat turn
 * and handed back in its done frame, so "view trace" and a support question
 * can start from the same string.
 *
 * The error handler is what replaced forty hand-rolled
 * `res.status(502).json({ error: String(err).slice(...) })` blocks: a route
 * throws or rejects, this answers. Transport failures toward a dependency
 * (Postgres, Ollama, Mapbox, a fetched page) are 502, everything else is 500,
 * and neither ever carries a stack.
 */
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "./log.js";

const log = logger("http");

const ID_SHAPE = /^[\w.-]{8,64}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const given = req.get("X-Request-Id");
  const id = given && ID_SHAPE.test(given) ? given : randomUUID();
  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);
  const t0 = Date.now();
  res.once("finish", () => {
    const record = {
      id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - t0,
    };
    if (res.statusCode >= 500) log.warn(record, "request");
    else log.debug(record, "request");
  });
  next();
}

/** The request id of the current response, for handlers that report it. */
export function currentRequestId(res: Response): string {
  return typeof res.locals.requestId === "string" ? res.locals.requestId : "";
}

export function notFound(req: Request, res: Response): void {
  res.status(404).json({
    error: `no route for ${req.method} ${req.path}`,
    requestId: currentRequestId(res),
  });
}

/** Failures that mean "a thing this server depends on did not answer". */
const UPSTREAM =
  /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|PostgrestError|ollama|mapbox|supabase|timed out|no answer|aborted|upstream/i;

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const id = currentRequestId(res);
  const message = String((err as Error)?.message ?? err).slice(0, 300);
  const status = UPSTREAM.test(String(err)) ? 502 : 500;
  log.error({ id, method: req.method, path: req.path, status, err: message }, "request failed");
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ error: message, requestId: id });
}

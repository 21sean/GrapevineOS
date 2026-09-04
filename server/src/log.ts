/**
 * One logger. Structured JSON in production, pretty on a terminal, and a
 * child per module so every line says where it came from without a bracket
 * prefix typed by hand.
 *
 * No pid and no hostname: the host name is the operator's machine, and this
 * output is meant to be pasteable into an issue.
 */
import { createRequire } from "node:module";
import pino, { type Logger } from "pino";

function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

const pretty =
  process.env.NODE_ENV !== "production" && process.stdout.isTTY === true && prettyAvailable();

export const log: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,
  ...(pretty && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
    },
  }),
});

/** A child logger named for the module, e.g. logger("discovery"). */
export function logger(name: string): Logger {
  return log.child({ name });
}

export type { Logger };

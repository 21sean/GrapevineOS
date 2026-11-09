import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { HostedProviderId } from "../types.js";

export const gatePython =
  process.env.GRAPEVINE_LLM_PYTHON ||
  fileURLToPath(
    new URL(
      process.platform === "win32"
        ? "../../../llm/.venv/Scripts/python.exe"
        : "../../../llm/.venv/bin/python",
      import.meta.url,
    ),
  );
const cwd = fileURLToPath(new URL("../../../llm", import.meta.url));

export function hostedModel(provider: HostedProviderId): string {
  return (
    process.env[`GRAPEVINE_${provider.toUpperCase()}_MODEL`]?.trim() ||
    (provider === "codex" ? "gpt-6-astra" : "best")
  );
}

/** Kill the complete process tree, including the CLI launched by Python. */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill();
    }
  }
}

let active = 0;
/** Isolated workers keep cancelling one hosted request from interrupting another. */
export async function runHostedWorker(opts: {
  provider?: HostedProviderId;
  input?: string;
  signal?: AbortSignal;
}): Promise<string> {
  opts.signal?.throwIfAborted();
  if (active >= 4) throw new Error("Hosted inference is busy. Try again in a moment.");
  active++;
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(
        gatePython,
        ["-m", opts.provider ? "grapevine_llm.worker" : "grapevine_llm.cli"],
        {
          cwd,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: "pipe",
          env: {
            ...process.env,
            PYTHONUTF8: "1",
            PYTHONUNBUFFERED: "1",
            GRAPEVINE_LLM_PROVIDER: opts.provider ?? "ollama",
          },
        },
      );
      let output = "";
      let size = 0;
      let failure: Error | undefined;
      const stop = (error: Error) => {
        if (failure) return;
        failure = error;
        killTree(child);
      };
      const abort = () => stop(new Error("Hosted inference cancelled"));
      const timer = setTimeout(
        () => stop(new Error("Hosted inference deadline exceeded")),
        opts.provider ? 125_000 : 45_000,
      );
      opts.signal?.addEventListener("abort", abort, { once: true });
      if (opts.signal?.aborted) abort();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > 2_000_000) stop(new Error("Oversized hosted inference reply"));
        else output += chunk;
      });
      child.stderr.on("data", () => {
        /* Never return private diagnostics. */
      });
      child.stdin.on("error", () => {
        /* close/error reports failure below */
      });
      child.on("error", () => {
        failure = new Error(
          "Install the locked Python environment: uv sync --locked --project llm",
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error("Provider worker failed. Check Admin → Providers."));
        else resolve(output);
      });
      child.stdin.end(opts.input ?? "");
    });
  } finally {
    active--;
  }
}

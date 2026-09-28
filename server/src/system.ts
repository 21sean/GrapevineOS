/**
 * Local hardware detection so the model catalog can say whether a model
 * fits this machine. Best effort: NVIDIA via nvidia-smi, Apple silicon via
 * unified memory, other Windows dGPUs via the driver registry. Cached for
 * the process lifetime, since hardware doesn't change under a running server.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const run = promisify(execFile);

export interface SystemInfo {
  ramGB: number;
  vramGB: number | null;
  gpu: string | null;
  unifiedMemory: boolean;
}

let cached: SystemInfo | null = null;

export async function systemInfo(): Promise<SystemInfo> {
  if (cached) return cached;
  const ramGB = Math.round(os.totalmem() / 2 ** 30);
  let vramGB: number | null = null;
  let gpu: string | null = null;
  const unifiedMemory = process.platform === "darwin";

  if (unifiedMemory) {
    gpu = os.cpus()[0]?.model ?? "Apple silicon";
    vramGB = ramGB; // GPU shares system memory
  } else {
    try {
      const { stdout } = await run(
        "nvidia-smi",
        ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
        { timeout: 5000 },
      );
      const [name, mib] = (stdout.trim().split("\n")[0] ?? "").split(",");
      if (name && Number(mib) > 0) {
        gpu = name.trim();
        vramGB = Math.round(Number(mib) / 1024);
      }
    } catch {
      /* no NVIDIA driver; try the registry below on Windows */
    }
    if (vramGB === null && process.platform === "win32") {
      try {
        const { stdout } = await run(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | " +
              "Where-Object { $_.'HardwareInformation.qwMemorySize' } | " +
              "Sort-Object 'HardwareInformation.qwMemorySize' -Descending | Select-Object -First 1 | " +
              "ForEach-Object { \"$($_.DriverDesc)|$($_.'HardwareInformation.qwMemorySize')\" }",
          ],
          { timeout: 8000 },
        );
        const [desc, bytes] = stdout.trim().split("|");
        if (Number(bytes) > 0) {
          gpu = desc || null;
          vramGB = Math.round(Number(bytes) / 2 ** 30);
        }
      } catch {
        /* leave unknown; the UI just skips the fit badges */
      }
    }
  }

  cached = { ramGB, vramGB, gpu, unifiedMemory };
  return cached;
}

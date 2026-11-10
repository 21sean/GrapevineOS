import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { assertLocal, readEnv, root, runNode, supabase, writeEnv } from "./local-tools.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "npm run setup [-- --hosted | --no-demo]\nDefault: local Supabase and demo events. Requires Docker. Hosted: create missing env templates only.",
  );
  process.exit(0);
}

try {
  if (args.some((arg) => !["--hosted", "--no-demo"].includes(arg)))
    throw new Error("Unknown option. Run npm run setup -- --help.");
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (!(
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) ||
    (major === 24 && minor >= 15) ||
    major >= 26
  )) {
    throw new Error("Install the Node version in .nvmrc before running setup.");
  }
  const serverFile = path.join(root, "server/.env");
  const webFile = path.join(root, "web/.env.local");
  if (args.includes("--hosted")) {
    for (const [file, example] of [
      [serverFile, "server/.env.example"],
      [webFile, "web/.env.example"],
    ]) {
      if (!existsSync(file)) copyFileSync(path.join(root, example), file);
    }
    console.log(
      "Existing configuration preserved. Fill the Supabase and Mapbox values in server/.env and web/.env.local.\nApply hosted migrations with npx supabase db push --remote, then run npm run doctor.",
    );
    process.exit(0);
  }
  const server = readEnv(serverFile);
  const web = readEnv(webFile);
  for (const value of [
    server.SUPABASE_URL,
    web.VITE_SUPABASE_URL,
    process.env.SUPABASE_URL,
    process.env.VITE_SUPABASE_URL,
  ]) {
    if (value && !value.includes("your-project")) assertLocal(value);
  }
  if (process.env.NODE_ENV === "production" || server.NODE_ENV === "production")
    throw new Error("Local setup is disabled in production.");
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", windowsHide: true });
  } catch {
    throw new Error(
      "Start Docker Desktop (or a Docker-compatible daemon), then rerun npm run setup.",
    );
  }
  // A named loopback network also confines published database and auth ports.
  const network = "grapevine-local";
  let networkInfo;
  try {
    networkInfo = JSON.parse(
      execFileSync("docker", ["network", "inspect", network], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    )[0];
  } catch {
    execFileSync(
      "docker",
      ["network", "create", "-o", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", network],
      { stdio: "ignore" },
    );
  }
  if (
    networkInfo &&
    networkInfo.Options?.["com.docker.network.bridge.host_binding_ipv4"] !== "127.0.0.1"
  )
    throw new Error("The grapevine-local Docker network must bind published ports to 127.0.0.1.");
  console.log("Starting local Supabase. The first run downloads container images.");
  // Capture CLI status output: it contains credentials and must not enter CI logs.
  supabase(
    [
      "start",
      "--network-id",
      network,
      "--exclude",
      "studio,postgres-meta,mailpit,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  supabase(["db", "push", "--yes"]);
  const status = JSON.parse(
    supabase(["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
  );
  const url = status.API_URL;
  const secret = status.SECRET_KEY || status.SERVICE_ROLE_KEY;
  const publishable = status.PUBLISHABLE_KEY || status.ANON_KEY;
  assertLocal(url);
  if (!secret || !publishable)
    throw new Error(
      "The local CLI did not return API keys. Run npx supabase status to inspect the stack.",
    );
  writeEnv(
    serverFile,
    {
      SUPABASE_URL: url,
      SUPABASE_SECRET_KEY: secret,
      HOST: "127.0.0.1",
      PORT: "8787",
      MAPBOX_SECRET_TOKEN: process.env.MAPBOX_SECRET_TOKEN || "",
      OLLAMA_URL: "http://localhost:11434",
      PUBLIC_BASE_URL: "http://localhost:5174",
    },
    [
      "SUPABASE_URL",
      "SUPABASE_SECRET_KEY",
      ...(/your[-_]|placeholder/i.test(server.MAPBOX_SECRET_TOKEN ?? "")
        ? ["MAPBOX_SECRET_TOKEN"]
        : []),
    ],
  );
  writeEnv(
    webFile,
    {
      VITE_SUPABASE_URL: url,
      VITE_SUPABASE_PUBLISHABLE_KEY: publishable,
      VITE_MAPBOX_TOKEN: process.env.VITE_MAPBOX_TOKEN || "",
    },
    [
      "VITE_SUPABASE_URL",
      "VITE_SUPABASE_PUBLISHABLE_KEY",
      ...(/your[-_]|placeholder/i.test(web.VITE_MAPBOX_TOKEN ?? "") ? ["VITE_MAPBOX_TOKEN"] : []),
    ],
  );
  const localEnv = { ...process.env, ...readEnv(serverFile) };
  if (!args.includes("--no-demo"))
    runNode(["--import", "tsx", "server/scripts/seed-demo.ts"], { env: localEnv });
  runNode(["scripts/doctor.mjs", "--browse"], { env: localEnv });
  console.log(
    "\nLocal setup complete. Run npm run dev, then open http://localhost:5174.\nEvent browsing needs no model. Add VITE_MAPBOX_TOKEN in web/.env.local for the map.\nFor chat and extraction, follow llm/README.md. OAuth providers need separate configuration.\nStop the database with npx supabase stop; rerun setup to resume it.",
  );
} catch (error) {
  console.error(`Setup failed: ${error.message}`);
  process.exitCode = 1;
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { isLocalUrl, mergeEnv } from "./local-tools.mjs";

test("local commands reject hosted URLs and deceptive loopback names", () => {
  for (const url of [
    "https://project.supabase.co",
    "http://localhost.example.com",
    "file://localhost/db",
    "http://localhost@remote.example",
    "http://user:pass@localhost",
  ])
    assert.equal(isLocalUrl(url), false);
  for (const url of ["http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321"])
    assert.equal(isLocalUrl(url), true);
});

test("env updates preserve custom settings and are idempotent", () => {
  const original =
    '# operator comment\nPORT=9999\nSUPABASE_SECRET_KEY="old"\nCUSTOM="keep # value"\n';
  const values = { PORT: "8787", SUPABASE_SECRET_KEY: "new", HOST: "127.0.0.1" };
  const next = mergeEnv(original, values, ["SUPABASE_SECRET_KEY"]);
  assert.ok(next.includes("# operator comment"));
  assert.deepEqual(parseEnv(next), {
    PORT: "9999",
    SUPABASE_SECRET_KEY: "new",
    CUSTOM: "keep # value",
    HOST: "127.0.0.1",
  });
  assert.equal(mergeEnv(next, values, ["SUPABASE_SECRET_KEY"]), next);
});

test("managed credentials update every duplicate declaration", () => {
  const text = "SUPABASE_SECRET_KEY=first\n  export SUPABASE_SECRET_KEY=last\n";
  const next = mergeEnv(text, { SUPABASE_SECRET_KEY: "new" }, ["SUPABASE_SECRET_KEY"]);
  assert.equal(parseEnv(next).SUPABASE_SECRET_KEY, "new");
  assert.ok(!next.includes("first") && !next.includes("last"));
});

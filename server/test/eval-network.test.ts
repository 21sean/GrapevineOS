import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("blocks external IPs, normalized socket options, DNS and fetch before I/O", () => {
  const guard = new URL("../scripts/eval-network.mjs", import.meta.url).href;
  const source = `
    const net = await import('node:net');
    const dns = await import('node:dns');
    const assert = await import('node:assert/strict');
    for (const args of [[443, '8.8.8.8'], [{port:443,host:'8.8.8.8'}], [[{port:443,host:'8.8.8.8'},null]], ['/tmp/remote.sock']]) {
      assert.throws(() => new net.Socket().connect(...args), /loopback/);
    }
    assert.throws(() => dns.lookup('example.com', () => {}), /loopback/);
    assert.throws(() => fetch('https://example.com'), /loopback/);
    console.log('blocked');
  `;
  expect(
    execFileSync(process.execPath, ["--import", guard, "--input-type=module", "-e", source], {
      encoding: "utf8",
    }).trim(),
  ).toBe("blocked");
});

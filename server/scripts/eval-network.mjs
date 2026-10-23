// Preload only in evaluation processes: the application still needs its data APIs.
import net from "node:net";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
const allowed = (host) =>
  host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node internally passes normalized [options, callback] arrays as well.
  const params = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof params[0] === "object" ? params[0] : null;
  const host = options?.host ?? (typeof params[1] === "string" ? params[1] : "localhost");
  if (options?.path || typeof params[0] === "string" || !allowed(host))
    throw new Error("Eval permits loopback sockets only");
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...args) {
  if (!allowed(host)) throw new Error("Eval permits loopback DNS names only");
  return lookup.call(this, host, ...args);
};
const promiseLookup = dns.promises.lookup;
dns.promises.lookup = function (host, ...args) {
  if (!allowed(host)) throw new Error("Eval permits loopback DNS names only");
  return promiseLookup.call(this, host, ...args);
};
// ESM named imports otherwise retain the original unguarded lookup function.
syncBuiltinESMExports();
const fetch = globalThis.fetch;
globalThis.fetch = function (input, options) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!allowed(url.hostname)) throw new Error("Eval permits loopback fetch only");
  return fetch(input, { ...options, redirect: "error" });
};

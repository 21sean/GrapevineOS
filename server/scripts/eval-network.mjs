// Preload only in evaluation processes: the application still needs its data APIs.
import net from "node:net";
import dns from "node:dns";
const allowed = (host) => host === "localhost" || host === "127.0.0.1" || host === "::1";
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = typeof args[0] === "object" ? args[0] : null;
  const host = options?.host ?? (typeof args[1] === "string" ? args[1] : "localhost");
  if (options?.path || !allowed(host)) throw new Error("Eval permits loopback sockets only");
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...args) {
  if (!allowed(host)) throw new Error("Eval permits loopback DNS names only");
  return lookup.call(this, host, ...args);
};
const fetch = globalThis.fetch;
globalThis.fetch = function (input, options) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!allowed(url.hostname)) throw new Error("Eval permits loopback fetch only");
  return fetch(input, { ...options, redirect: "error" });
};

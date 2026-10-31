/**
 * Offline seam for every test: replaces the network at the http.ts boundary.
 *
 * http.ts is the only HTTP client. It has two transports — global fetch for our own
 * URLs, node:http(s) with a checked connect-time lookup for untrusted ones — and
 * both are faked here, together with DNS. Anything a test did not route throws, so
 * a leaked live call turns a test red instead of slow.
 *
 * Both fakes resolve the host when they "connect", like the real thing, and record
 * the address in `kall[].adresse`: that is how a test sees WHERE a request would
 * have gone, not just which URL was asked for.
 *
 * Importing this module also points the disk cache at a fresh temp dir. cache.ts
 * reads XDG_CACHE_HOME when it is first imported, so test files import this module
 * BEFORE they `await import("../dist/...")`. `node --test` runs each file in its own
 * process, so the dir (and module state) never leaks between files.
 */
import dns from "node:dns";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "datakilder-test-"));

/** Any public address. Never contacted: the transports are fake too. */
export const OFFENTLIG_IP = "151.101.1.1";

/**
 * Install fake DNS + fake transports for the duration of test `t`.
 *
 * `ruter(url, init)` returns a Response, or undefined for "not expected".
 * `navn` maps hostname → address, or → a list of addresses answered in turn (the
 * last one repeats) to play a rebinding server. Unknown names resolve to a public
 * address, so tests that do not care about DNS need not list every host.
 *
 * Returns the calls that reached a server — after DNS, so a request refused at
 * lookup is not in the list.
 */
export function falskFetch(t, ruter, navn = {}) {
  const svarFor = { localhost: "127.0.0.1", ...navn };
  const oppslag = {};
  t.mock.method(dns.promises, "lookup", async (host) => {
    const svar = svarFor[host] ?? OFFENTLIG_IP;
    const liste = Array.isArray(svar) ? svar : [svar];
    const n = (oppslag[host] = (oppslag[host] ?? 0) + 1);
    const address = liste[Math.min(n, liste.length) - 1];
    return [{ address, family: isIP(address) }];
  });

  const kall = [];

  const falskFetch = async (url, init = {}) => {
    const href = String(url);
    const host = new URL(href).hostname.replace(/^\[|\]$/g, "");
    // Real fetch resolves the name itself when it connects.
    const adresse = isIP(host) ? host : (await dns.promises.lookup(host, { all: true }))[0].address;
    kall.push({ url: href, init, adresse });
    if (init.signal?.aborted) throw avbrutt();
    const res = await ruter(href, init);
    if (!res) throw new Error(`uventet nettverkskall: ${href}`);
    // Real fetch follows redirects unless told "manual" — so must the fake, or a
    // test of redirect handling would pass against code that never looked.
    const location = res.headers.get("location");
    if (init.redirect !== "manual" && res.status >= 300 && res.status < 400 && location) {
      return falskFetch(new URL(location, href).toString(), init);
    }
    return res;
  };
  t.mock.method(globalThis, "fetch", falskFetch);

  /**
   * Fake http(s).request. Like net.connect, it skips the lookup for an IP literal
   * and otherwise calls the caller's `lookup` option — the hook under test — with
   * `all: true`, as Node 20+ does with autoSelectFamily on. Never follows redirects.
   *
   * The response callback runs from a plain macrotask, outside any promise chain —
   * as Node runs it from the HTTP parser. A throw in it is then an uncaught
   * exception, which is what kills the real server; inside `.then()` it would
   * quietly become a rejection nobody sees.
   */
  const falskRequest = (url, opts, svarTil) => {
    const req = new EventEmitter();
    req.destroy = (err) => err && req.emit("error", err);
    req.end = (body) => {
      koble(String(url), opts, body).then(
        (melding) => setImmediate(() => svarTil(melding)),
        (err) => req.emit("error", err),
      );
      return req;
    };
    return req;
  };
  const koble = async (href, opts, body) => {
    const host = new URL(href).hostname.replace(/^\[|\]$/g, "");
    const adresse = isIP(host)
      ? host
      : await new Promise((ok, feil) =>
          opts.lookup(host, { all: true }, (err, a) => (err ? feil(err) : ok(Array.isArray(a) ? a[0].address : a))),
        );
    const init = {
      method: opts.method,
      headers: opts.headers,
      body,
      signal: opts.signal,
      redirect: "manual",
      transport: "pinned",
      agent: opts.agent,
    };
    kall.push({ url: href, init, adresse });
    if (opts.signal?.aborted) throw avbrutt();
    // The router gets no signal: on this transport the abort is Node's, not the
    // stream's. Verified on Node 20 and 22 against a local server: aborting after
    // headers fails the body read with Error "aborted", code ECONNRESET — NOT an
    // AbortError, which is what fetch gives.
    const res = await ruter(href, { ...init, signal: undefined });
    if (!res) throw new Error(`uventet nettverkskall: ${href}`);
    const raatt = res instanceof RaattSvar;
    const melding = raatt
      ? Readable.from([Buffer.from(res.body)])
      : res.body
        ? Readable.fromWeb(res.body)
        : Readable.from([]);
    melding.statusCode = res.status;
    melding.statusMessage = raatt ? "" : res.statusText;
    melding.headers = raatt ? res.headers : Object.fromEntries(res.headers);
    opts.signal?.addEventListener("abort", () =>
      melding.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET" })),
    );
    return melding;
  };
  t.mock.method(http, "request", falskRequest);
  t.mock.method(https, "request", falskRequest);

  return kall;
}

export function svar(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

/**
 * A reply the fetch Response constructor refuses to build — 205 with a body, status
 * 999 — but Node's HTTP parser accepts. Only the node:http fake can deliver it,
 * which is the point: the pinned transport must not trust the wire to be valid.
 */
class RaattSvar {
  constructor(status, body, headers) {
    Object.assign(this, { status, body, headers });
  }
}
export function raattSvar(status, body = "", headers = {}) {
  return new RaattSvar(status, body, headers);
}

/**
 * Headers now, one byte, then nothing — a server dripping its body. Errors when the
 * request's signal aborts, which is what real fetch does (verified on Node 20 and 22
 * against a local server: a pending body read rejects with AbortError).
 */
export function haengendeBody(signal) {
  return new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([0x3c]));
      signal?.addEventListener("abort", () => c.error(avbrutt()));
    },
  });
}

function avbrutt() {
  return new DOMException("This operation was aborted", "AbortError");
}

export function verktoy(kilde, navn) {
  const t = kilde.tools.find((x) => x.name === navn);
  if (!t) throw new Error(`${kilde.id}_${navn} finnes ikke`);
  return t.run;
}

/**
 * Settles with "HANG" if `p` has not settled within `ms` of real time. Captured at
 * import, before any test mocks setTimeout, so it works under mock timers too.
 */
const ekteSetTimeout = globalThis.setTimeout;
export function innen(ms, p) {
  return Promise.race([
    p.then(
      (v) => ({ ok: v }),
      (e) => ({ feil: e }),
    ),
    new Promise((r) => ekteSetTimeout(() => r("HANG"), ms)),
  ]);
}

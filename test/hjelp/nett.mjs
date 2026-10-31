/**
 * Offline seam for every test: replaces the network at the http.ts boundary.
 *
 * http.ts is the only HTTP client, so faking `globalThis.fetch` and the DNS lookup
 * covers every source. Anything a test did not route throws, so a leaked live call
 * turns a test red instead of slow.
 *
 * Importing this module also points the disk cache at a fresh temp dir. cache.ts
 * reads XDG_CACHE_HOME when it is first imported, so test files import this module
 * BEFORE they `await import("../dist/...")`. `node --test` runs each file in its own
 * process, so the dir (and module state) never leaks between files.
 */
import dns from "node:dns";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "datakilder-test-"));

/** Any public address. Never contacted: fetch is fake too. */
export const OFFENTLIG_IP = "151.101.1.1";

/**
 * Install a fake fetch for the duration of test `t`.
 * `ruter(url, init)` returns a Response, or undefined for "not expected".
 * Returns the list of calls made, so a test can assert that nothing was fetched.
 */
export function falskFetch(t, ruter) {
  const kall = [];
  const falsk = async (url, init = {}) => {
    const href = String(url);
    kall.push({ url: href, init });
    if (init.signal?.aborted) throw avbrutt();
    const res = await ruter(href, init);
    if (!res) throw new Error(`uventet nettverkskall: ${href}`);
    // Real fetch follows redirects unless told "manual" — so must the fake, or a
    // test of redirect handling would pass against code that never looked.
    const location = res.headers.get("location");
    if (init.redirect !== "manual" && res.status >= 300 && res.status < 400 && location) {
      return falsk(new URL(location, href).toString(), init);
    }
    return res;
  };
  t.mock.method(globalThis, "fetch", falsk);
  return kall;
}

/**
 * Install a fake DNS. `navn` maps hostname → address; unknown names resolve to a
 * public address, so tests that do not care about DNS need not list every host.
 */
export function falskDns(t, navn = {}) {
  const alle = { localhost: "127.0.0.1", ...navn };
  t.mock.method(dns.promises, "lookup", async (host) => {
    const address = alle[host] ?? OFFENTLIG_IP;
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  });
}

export function svar(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
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

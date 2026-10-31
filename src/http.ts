import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { readCache, writeCache } from "./cache.js";
import { SourceError } from "./source.js";

/**
 * The ONE HTTP client every source uses. Do not write a second one.
 *
 * Norwegian public APIs share the same handful of manners: they want a real
 * User-Agent (MET rejects requests without one), they rate limit, and a few of
 * them return 200 with an HTML error page. Solving that once means source
 * number six inherits it instead of re-learning it.
 */

const USER_AGENT =
  "datakilder-mcp (+https://github.com/smlhus1/datakilder-mcp)";

/** Hard ceiling so a source that returns a 2 GB dump cannot take the server down. */
const MAX_BYTES = 8 * 1024 * 1024;

const TIMEOUT_MS = 30_000;

/**
 * Longest Retry-After we will sleep on. A 429 asking for a day must fail now with a
 * clear message, not hold the tool call (and doctor, and the ops job) for a day.
 */
const MAX_RETRY_AFTER_S = 30;

const MAX_REDIRECTS = 5;

/**
 * Own agents for the pinned transport, never the global ones: with
 * NODE_USE_ENV_PROXY set, the global agents send requests via HTTP(S)_PROXY, and
 * the proxy — not our lookup hook — would resolve the name.
 */
const PINNED_HTTP_AGENT = new http.Agent();
const PINNED_HTTPS_AGENT = new https.Agent();

/**
 * Addresses a caller-supplied URL must never reach: "this network", RFC 1918,
 * CGNAT (the tailnet lives in 100.64/10), loopback, link-local (169.254.169.254 is
 * the cloud metadata service), multicast/reserved — and the IPv6 equivalents.
 * BlockList matches IPv4-mapped IPv6 (::ffff:7f00:1) against the IPv4 rules itself;
 * do not add ::ffff:0:0/96, it also matches every plain IPv4 address.
 */
const IKKE_OFFENTLIG = new BlockList();
for (const [nett, prefiks] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 3],
] as const) {
  IKKE_OFFENTLIG.addSubnet(nett, prefiks, "ipv4");
}
for (const [nett, prefiks] of [
  // ::/96 is "unspecified" plus IPv4-compatible (::127.0.0.1), which BlockList
  // does not map to the IPv4 rules the way it does ::ffff:.
  ["::", 96],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  IKKE_OFFENTLIG.addSubnet(nett, prefiks, "ipv6");
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  /** Retries on 429/503. Kept low — a slow tool is better than a hung one. */
  retries?: number;
  /**
   * How long this exact response may be reused. Per call, not per source: Entur's
   * stop places are stable for weeks while its departures are realtime.
   * Omit or 0 to always hit the network.
   */
  cacheTtlMs?: number;
  /**
   * The URL came from the caller or from upstream data, not from our own code.
   * Refuses hosts that are, or resolve to, a non-public address — on every redirect
   * hop, not just the first. Without it, kart_punkt is a proxy that reads the
   * metadata service or anything on the tailnet back to the model.
   */
  publicHostsOnly?: boolean;
  /**
   * Throws if a successful body is an error in disguise. Runs before caching, so a
   * WMS "server busy" sent with status 200 is not served from disk for a week.
   */
  validate?: (text: string) => void;
}

/** A response with its body already read — the body is inside the timeout. */
interface Svar {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  text: string;
}

async function request(url: string, opts: RequestOptions = {}, attempt = 0): Promise<Svar> {
  const { retries = 2 } = opts;
  const res = await requestOnce(url, opts);

  if ((res.status === 429 || res.status === 503) && attempt < retries) {
    await new Promise((r) => setTimeout(r, waitBeforeRetry(url, res, attempt)));
    return request(url, opts, attempt + 1);
  }

  return res;
}

function waitBeforeRetry(url: string, res: Svar, attempt: number): number {
  // An HTTP-date Retry-After parses as NaN and falls through to backoff.
  const retryAfter = Number(res.headers.get("retry-after"));
  if (!(Number.isFinite(retryAfter) && retryAfter > 0)) return (attempt + 1) * 1500;
  if (retryAfter > MAX_RETRY_AFTER_S) {
    throw new SourceError(
      `${url} ga HTTP ${res.status} og ba oss vente ${retryAfter} s. Det er mer enn ` +
        `${MAX_RETRY_AFTER_S} s, så vi gir opp nå i stedet for å henge — prøv igjen senere.`,
      res.status,
    );
  }
  return retryAfter * 1000;
}

/** What both transports are given: plain enough for fetch and for node:http. */
interface Forespørsel {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

async function requestOnce(url: string, opts: RequestOptions): Promise<Svar> {
  const { method = "GET", body, headers = {}, publicHostsOnly = false } = opts;

  // One timer for headers AND body. Clearing it when the headers arrived let a
  // server that sends "200" and then drips its body hang us forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const init: Forespørsel = {
      method,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    };
    const res = publicHostsOnly ? await fetchPublic(url, init) : await fetch(url, init);
    // The body of an error is only a detail for the message; failing to read it
    // must not hide the status.
    const text = res.ok ? await readCapped(res) : await readCapped(res).catch(() => "");
    return { ok: res.ok, status: res.status, statusText: res.statusText, headers: res.headers, text };
  } catch (err) {
    if (err instanceof SourceError) throw err;
    // Asked of the signal, not the error: fetch fails with an AbortError, but
    // node:http fails a body read with Error "aborted" (ECONNRESET).
    if (controller.signal.aborted) {
      throw new SourceError(`${url} svarte ikke innen ${TIMEOUT_MS / 1000} s.`);
    }
    throw new SourceError(`Nådde ikke ${url}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every hop — the first and each redirect — must be a public host. Redirects are
 * followed here rather than by the transport, so each one is checked.
 */
async function fetchPublic(url: string, init: Forespørsel): Promise<Response> {
  let hop = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await requestPinned(hop, init);
    const location = res.headers.get("location");
    if (res.status < 300 || res.status > 399 || !location) return res;
    await res.body?.cancel();
    hop = new URL(location, hop).toString();
  }
  throw new SourceError(`${url} videresendte mer enn ${MAX_REDIRECTS} ganger.`);
}

/**
 * node:http(s) instead of fetch, for one reason: the `lookup` hook. The blocklist
 * runs inside the connection's own DNS lookup, so the address checked is the
 * address connected to. Checking first and letting fetch resolve again let a TTL-0
 * rebinding host answer public to the check and 127.0.0.1 to the connect.
 *
 * Returns a web Response, so the timeout, size cap and redirect handling above
 * treat both transports alike. Called through the http/https objects so tests can
 * stub them.
 */
async function requestPinned(url: string, init: Forespørsel): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new SourceError(`Bare http(s) støttes, fikk "${u.protocol}".`);
  }
  // net.connect skips `lookup` for an IP literal, so those are checked here. The
  // URL parser has already turned 0x7f.1 and 2130706433 into 127.0.0.1.
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) assertPublicAddress(u.hostname, host);

  const secure = u.protocol === "https:";
  const transport = secure ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      u,
      {
        method: init.method,
        headers: init.headers,
        signal: init.signal,
        lookup: checkedLookup,
        agent: secure ? PINNED_HTTPS_AGENT : PINNED_HTTP_AGENT,
      },
      (res) => {
        // This callback runs from Node's HTTP parser, outside any promise: a throw
        // here is an uncaught exception that takes the whole stdio server down. The
        // wire is the remote's to shape, so everything that can throw on it is caught.
        try {
          resolve(toWebResponse(url, res));
        } catch (err) {
          res.destroy();
          reject(
            err instanceof SourceError
              ? err
              : new SourceError(`${url} ga et svar vi ikke kan lese: ${(err as Error).message}`),
          );
        }
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

/**
 * Response accepts only 200–599 and refuses a body on the null-body statuses; Node's
 * parser accepts any three digits. 1xx never reaches the response callback in a
 * well-behaved exchange, so anything outside 200–599 is a broken reply.
 */
const NULL_BODY = new Set([204, 205, 304]);

function toWebResponse(url: string, res: http.IncomingMessage): Response {
  const status = res.statusCode ?? 0;
  if (status < 200 || status > 599) {
    throw new SourceError(`${url} svarte med ugyldig HTTP-status ${status}.`, status);
  }
  const headers = new Headers();
  for (const [navn, verdi] of Object.entries(res.headers)) {
    if (verdi !== undefined) headers.set(navn, Array.isArray(verdi) ? verdi.join(", ") : verdi);
  }
  if (NULL_BODY.has(status)) {
    res.resume();
    return new Response(null, { status, statusText: res.statusMessage, headers });
  }
  const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status, statusText: res.statusMessage, headers });
}

/**
 * The connection's own DNS lookup, with the blocklist applied to every answer.
 * Node calls it with `all: true` (autoSelectFamily, the default since Node 20) and
 * wants an array back, or without it and wants (address, family). Both are served.
 */
const checkedLookup: LookupFunction = (hostname, options, callback) => {
  // Called through the dns object (not a destructured lookup) so tests can stub it.
  dns.lookup(hostname, { ...options, all: true }).then(
    (adresser) => {
      try {
        for (const a of adresser) assertPublicAddress(hostname, a.address);
      } catch (err) {
        callback(err as NodeJS.ErrnoException, "");
        return;
      }
      if (options.all) callback(null, adresser);
      else callback(null, adresser[0].address, adresser[0].family);
    },
    (err) => callback(err, ""),
  );
};

function assertPublicAddress(hostname: string, adresse: string): void {
  if (IKKE_OFFENTLIG.check(adresse, isIP(adresse) === 6 ? "ipv6" : "ipv4")) {
    throw new SourceError(
      `${hostname} peker til en intern adresse (${adresse}). Bare offentlige tjenester kan spørres.`,
    );
  }
}

/**
 * Fetch and parse JSON.
 *
 * Checks the content type before parsing: several of these APIs answer a bad
 * request with an HTML page and status 200, and "Unexpected token < in JSON"
 * is a much worse error message than saying so.
 */
export async function getJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  const key = cacheKey(url, opts);
  if (opts.cacheTtlMs) {
    const hit = readCache(key);
    if (hit !== null) return JSON.parse(hit) as T;
  }

  const res = await request(url, opts);

  if (!res.ok) {
    const detail = res.text.slice(0, 300);
    throw new SourceError(
      `${url} ga HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
      res.status,
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  const text = res.text;

  if (!/json/i.test(contentType)) {
    throw new SourceError(
      `${url} svarte med "${contentType || "ukjent type"}", ikke JSON. ` +
        `Første tegn: ${text.slice(0, 120)}`,
    );
  }

  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    throw new SourceError(`${url} ga ugyldig JSON (${text.length} tegn lest).`);
  }

  opts.validate?.(text);
  // Only successful, parseable responses are cached — never an error page.
  if (opts.cacheTtlMs) writeCache(key, text, opts.cacheTtlMs);
  return parsed;
}

/** The body is part of the key: SSB and Entur ask different questions of one URL. */
function cacheKey(url: string, opts: RequestOptions): string {
  return `${opts.method ?? "GET"} ${url} ${opts.body ? JSON.stringify(opts.body) : ""}`;
}

/**
 * Same client, plain text out. Exists for WMS, which answers XML — and answers
 * errors as XML with status 200, so the caller has to inspect the body.
 */
export async function getText(url: string, opts: RequestOptions = {}): Promise<string> {
  const key = cacheKey(url, opts);
  if (opts.cacheTtlMs) {
    const hit = readCache(key);
    if (hit !== null) return hit;
  }

  const res = await request(url, opts);
  if (!res.ok) {
    throw new SourceError(`${url} ga HTTP ${res.status} ${res.statusText}`, res.status);
  }
  opts.validate?.(res.text);
  if (opts.cacheTtlMs) writeCache(key, res.text, opts.cacheTtlMs);
  return res.text;
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new SourceError(
        `Svaret oversteg ${MAX_BYTES / 1024 / 1024} MB. Snevre inn spørringen (færre dimensjoner, kortere tidsserie).`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

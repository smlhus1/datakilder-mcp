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

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  /** Retries on 429/503. Kept low — a slow tool is better than a hung one. */
  retries?: number;
}

async function request(url: string, opts: RequestOptions = {}, attempt = 0): Promise<Response> {
  const { method = "GET", body, headers = {}, retries = 2 } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      throw new SourceError(`${url} svarte ikke innen ${TIMEOUT_MS / 1000} s.`);
    }
    throw new SourceError(`Nådde ikke ${url}: ${(err as Error).message}`);
  }
  clearTimeout(timer);

  if ((res.status === 429 || res.status === 503) && attempt < retries) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 1500;
    await new Promise((r) => setTimeout(r, waitMs));
    return request(url, opts, attempt + 1);
  }

  return res;
}

/**
 * Fetch and parse JSON.
 *
 * Checks the content type before parsing: several of these APIs answer a bad
 * request with an HTML page and status 200, and "Unexpected token < in JSON"
 * is a much worse error message than saying so.
 */
export async function getJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(url, opts);

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new SourceError(
      `${url} ga HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`,
      res.status,
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  const text = await readCapped(res);

  if (!/json/i.test(contentType)) {
    throw new SourceError(
      `${url} svarte med "${contentType || "ukjent type"}", ikke JSON. ` +
        `Første tegn: ${text.slice(0, 120)}`,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SourceError(`${url} ga ugyldig JSON (${text.length} tegn lest).`);
  }
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

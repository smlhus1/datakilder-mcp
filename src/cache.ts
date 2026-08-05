import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Disk cache with a per-call TTL.
 *
 * Three reasons this exists, in order of importance:
 *   1. MET's terms of service explicitly ask clients to cache. Not caching is
 *      impolite to a free public service, not just slow for us.
 *   2. Some of these responses are heavy — the school register is 7.5 MB, NVDB's
 *      type catalogue 544 KB — and they change a few times a year.
 *   3. An agent asks the same question repeatedly within one conversation.
 *
 * The TTL is per CALL, not per source, because the split runs through the middle
 * of a source: Entur's stop places are stable for weeks while its departures are
 * realtime and must never be served from cache. A per-source setting would force
 * the wrong answer for one of them.
 */

const DIR = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "datakilder-mcp",
);

let ready = false;
function ensureDir(): string {
  if (!ready) {
    try {
      mkdirSync(DIR, { recursive: true });
      ready = true;
    } catch {
      // A read-only home is not a reason to fail a data lookup — fall back to
      // the temp dir, and if that fails too the caller just runs uncached.
      try {
        mkdirSync(join(tmpdir(), "datakilder-mcp"), { recursive: true });
        ready = true;
        return join(tmpdir(), "datakilder-mcp");
      } catch {
        return DIR;
      }
    }
  }
  return DIR;
}

function pathFor(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return join(ensureDir(), `${hash}.json`);
}

export function readCache(key: string): string | null {
  try {
    const raw = readFileSync(pathFor(key), "utf8");
    const { expires, body } = JSON.parse(raw) as { expires: number; body: string };
    // Reading a stale entry costs a file read; serving one costs correctness.
    if (typeof expires !== "number" || Date.now() > expires) return null;
    return body;
  } catch {
    return null;
  }
}

export function writeCache(key: string, body: string, ttlMs: number): void {
  if (ttlMs <= 0) return;
  try {
    writeFileSync(pathFor(key), JSON.stringify({ expires: Date.now() + ttlMs, body }));
  } catch {
    // Caching is an optimisation. Losing it must never lose the answer.
  }
}

/** Named windows, so a source says what it means rather than doing arithmetic inline. */
export const TTL = {
  ingen: 0,
  minutter: 10 * 60_000,
  time: 60 * 60_000,
  dag: 24 * 60 * 60_000,
  uke: 7 * 24 * 60 * 60_000,
  maned: 30 * 24 * 60 * 60_000,
} as const;

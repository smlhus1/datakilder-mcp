import { settOmgaaCache } from "./cache.js";
import { SOURCES } from "./sources/index.js";

/**
 * Health check across every source: what is up right now, how fast, what is down.
 *
 * The smoke test already calls every API for real, but only when a developer runs
 * it. An API that changed its contract last Tuesday stays invisible until someone
 * asks a question mid-conversation and gets a confusing error. This is the same
 * idea made askable — as an MCP tool, and as `npm run doctor`.
 *
 * The probe lives on each source, declared next to the tools it exercises. A source
 * that declares none is reported as unchecked, never as healthy: "we did not look"
 * and "it works" must not look the same.
 *
 * Cache is bypassed for the duration. The first version of this reported 15/15 up
 * in 855 ms — off disk. That is the same failure in a new place: a check that
 * cannot tell "the source answered" from "we remember it answering" always says
 * everything is fine.
 */

export interface Helsesvar {
  id: string;
  navn: string;
  status: "ok" | "feil" | "mangler_nøkkel" | "ikke_sjekket";
  ms?: number;
  detalj?: string;
}

export async function doctor(): Promise<{
  sjekket: string;
  brukt_ms: number;
  oppsummering: Record<string, number>;
  kilder: Helsesvar[];
}> {
  const start = Date.now();
  settOmgaaCache(true);
  try {
    return await sjekkAlle(start);
  } finally {
    // Restored even if a probe throws: leaving the cache off would quietly make
    // every later call hit the network.
    settOmgaaCache(false);
  }
}

async function sjekkAlle(start: number) {
  const kilder = await Promise.all(
    SOURCES.map(async (kilde): Promise<Helsesvar> => {
      const felles = { id: kilde.id, navn: kilde.name };

      if (kilde.requiresKeyEnv && !process.env[kilde.requiresKeyEnv]) {
        return { ...felles, status: "mangler_nøkkel", detalj: `Sett ${kilde.requiresKeyEnv}` };
      }
      if (!kilde.helse) {
        return { ...felles, status: "ikke_sjekket", detalj: "Kilden har ingen helsesjekk" };
      }

      const verktoy = kilde.tools.find((t) => t.name === kilde.helse!.verktoy);
      if (!verktoy) {
        // Without this, renaming a tool leaves a probe that silently never runs.
        return {
          ...felles,
          status: "feil",
          detalj: `Helsesjekken peker på ${kilde.id}_${kilde.helse.verktoy}, som ikke finnes`,
        };
      }

      const t0 = Date.now();
      try {
        await verktoy.run(kilde.helse.args);
        return { ...felles, status: "ok", ms: Date.now() - t0 };
      } catch (err) {
        return {
          ...felles,
          status: "feil",
          ms: Date.now() - t0,
          detalj: (err as Error).message.slice(0, 200),
        };
      }
    }),
  );

  const tell = (s: Helsesvar["status"]) => kilder.filter((r) => r.status === s).length;

  return {
    sjekket: new Date().toISOString(),
    brukt_ms: Date.now() - start,
    oppsummering: {
      ok: tell("ok"),
      feil: tell("feil"),
      mangler_nøkkel: tell("mangler_nøkkel"),
      ikke_sjekket: tell("ikke_sjekket"),
    },
    // Slowest first: the useful reading is which source is dragging.
    kilder: kilder.sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)),
  };
}

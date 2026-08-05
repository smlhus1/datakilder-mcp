import type { Source } from "../source.js";
import { artsdatabanken } from "./artsdatabanken.js";
import { brreg } from "./brreg.js";
import { entur } from "./entur.js";
import { eurostat } from "./eurostat.js";
import { fdk } from "./fdk.js";
import { stedskontekst } from "./kontekst.js";
import { kart } from "./kart.js";
import { kartverket } from "./kartverket.js";
import { met } from "./met.js";
import { ssb } from "./ssb.js";
import { udir } from "./udir.js";
import { vegvesen } from "./vegvesen.js";

/**
 * The registry. Adding a source = write one file, add one line here.
 *
 * Nothing else in the server enumerates sources — tool registration, the
 * `kilder` overview and the attribution lines are all derived from this array.
 */
export const SOURCES: Source[] = [ssb, brreg, met, kartverket, vegvesen, entur, kart, udir, artsdatabanken, eurostat, fdk, stedskontekst];

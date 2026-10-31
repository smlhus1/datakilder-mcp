import { test } from "node:test";
import assert from "node:assert/strict";
import { falskFetch, svar, verktoy } from "./hjelp/nett.mjs";

const { kart } = await import("../dist/sources/kart.js");

const CAPABILITIES =
  "<WMS_Capabilities><Service><Title>Topo</Title></Service><Capability><Layer><Title>rot</Title>" +
  "<Layer><Name>topo</Name><Title>Topografisk</Title></Layer></Layer></Capability></WMS_Capabilities>";
const OPPTATT = "<ServiceExceptionReport><ServiceException>Server busy</ServiceException></ServiceExceptionReport>";

test("C1: a WMS ServiceException (status 200) is not cached", async (t) => {
  let n = 0;
  const kall = falskFetch(t, () => svar(n++ === 0 ? OPPTATT : CAPABILITIES, { headers: { "content-type": "text/xml" } }));
  const url = "https://wms.geonorge.no/skwms1/wms.topo";

  await assert.rejects(verktoy(kart, "lag")({ url }), /Server busy/);
  const andre = await verktoy(kart, "lag")({ url });

  assert.equal(kall.length, 2, "the second call was served the cached error instead of asking again");
  assert.equal(andre.antallLag, 1);
});

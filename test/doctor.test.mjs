import { test } from "node:test";
import assert from "node:assert/strict";
import { falskDns, falskFetch, svar } from "./hjelp/nett.mjs";

const { doctor } = await import("../dist/doctor.js");

test("C2: with every upstream down, no source reports ok", async (t) => {
  falskDns(t);
  // 500 rather than 503: 503 is retried with real backoff sleeps, and "down" is the point here.
  falskFetch(t, () => svar("nede", { status: 500 }));

  const res = await doctor();

  const ok = res.kilder.filter((k) => k.status === "ok").map((k) => k.id);
  assert.deepEqual(ok, [], `reported ok while every upstream answered 500: ${ok.join(", ")}`);
  for (const id of ["ogc", "sted", "ngu"]) {
    assert.equal(res.kilder.find((k) => k.id === id)?.status, "feil", id);
  }
  assert.equal(res.oppsummering.ok, 0);
});

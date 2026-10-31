import { test } from "node:test";
import assert from "node:assert/strict";
import { falskFetch, haengendeBody, innen, svar } from "./hjelp/nett.mjs";

const { getJson, getText } = await import("../dist/http.js");

/** Let every pending promise continuation run (setImmediate is not mocked). */
const flush = () => new Promise((r) => setImmediate(r));

test("T1: a body that drips forever times out instead of hanging", async (t) => {
  falskFetch(t, (_url, init) => svar(haengendeBody(init.signal), { headers: { "content-type": "text/xml" } }));
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const p = getText("https://drypp.example/wms");
  await flush();
  await flush();
  t.mock.timers.tick(30_000);

  const r = await innen(1000, p);
  assert.notEqual(r, "HANG", "getText was still waiting for the body after the 30 s timeout");
  assert.match(r.feil?.message ?? "", /svarte ikke innen 30 s/);
});

test("T2: Retry-After above the cap fails fast instead of sleeping", async (t) => {
  const kall = falskFetch(t, () => svar("busy", { status: 429, headers: { "retry-after": "86400" } }));
  // Mocked so the unfixed code's day-long sleep is a fake timer, not one that keeps
  // this test process alive.
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const r = await innen(1000, getJson("https://travel.example/x"));
  assert.notEqual(r, "HANG", "getJson went to sleep on Retry-After: 86400");
  assert.equal(kall.length, 1);
  assert.equal(r.feil?.status, 429);
  assert.match(r.feil?.message ?? "", /86400/);
});

test("T2b: Retry-After within the cap is still honoured", async (t) => {
  let n = 0;
  const kall = falskFetch(t, () =>
    n++ === 0
      ? svar("busy", { status: 429, headers: { "retry-after": "2" } })
      : svar('{"ok":true}', { headers: { "content-type": "application/json" } }),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const p = getJson("https://travel.example/y");
  await flush();
  await flush();
  t.mock.timers.tick(2_000);

  const r = await innen(1000, p);
  assert.deepEqual(r, { ok: { ok: true } });
  assert.equal(kall.length, 2);
});

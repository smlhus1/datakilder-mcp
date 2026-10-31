import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { falskFetch, haengendeBody, innen, raattSvar, svar } from "./hjelp/nett.mjs";

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

test("T1p: the same drip times out on the pinned (publicHostsOnly) transport", async (t) => {
  const kall = falskFetch(t, (_url, init) =>
    svar(haengendeBody(init.signal), { headers: { "content-type": "text/xml" } }),
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const p = getText("https://drypp.example/wms", { publicHostsOnly: true });
  await flush();
  await flush();
  t.mock.timers.tick(30_000);

  const r = await innen(1000, p);
  assert.notEqual(r, "HANG", "the pinned transport was still waiting for the body after 30 s");
  assert.match(r.feil?.message ?? "", /svarte ikke innen 30 s/);
  assert.equal(kall[0]?.init.transport, "pinned", "did not go through the pinned transport");
});

test("P2: the pinned transport uses its own agent, never the global one", async (t) => {
  // With NODE_USE_ENV_PROXY, the global agents route via HTTP(S)_PROXY and the
  // proxy resolves the name — around the lookup hook. undefined = global agent.
  const kall = falskFetch(t, () => svar("<x/>", { headers: { "content-type": "text/xml" } }));
  await getText("https://wms.offentlig.example/", { publicHostsOnly: true });
  await getText("http://wms.offentlig.example/", { publicHostsOnly: true });
  for (const [k, global] of [[kall[0], https.globalAgent], [kall[1], http.globalAgent]]) {
    assert.ok(k.init.agent, `${k.url}: no agent passed, so the global one is used`);
    assert.notEqual(k.init.agent, global, `${k.url}: the global agent`);
  }
});

// Red before the fix: the response callback threw, an uncaught exception that kills
// the stdio server. node:test reports it, and the call never settles ("HANG").
for (const [navn, status, forventet] of [
  // A null-body status: the body is discarded, not trusted.
  ["205 with a body", 205, { ok: "" }],
  // Node's parser accepts any three digits; Response only 200–599.
  ["status 999", 999, "SourceError"],
]) {
  test(`P1: a hostile ${navn} on the pinned transport is handled, not a crash`, async (t) => {
    falskFetch(t, () => raattSvar(status, "x", { "content-type": "text/xml" }));
    const r = await innen(1000, getText("https://fiendtlig.example/wms", { publicHostsOnly: true }));
    assert.notEqual(r, "HANG", "no answer: the response callback threw");
    if (forventet === "SourceError") assert.equal(r.feil?.name, "SourceError", `got ${r.feil?.message}`);
    else assert.deepEqual(r, forventet);
  });
}

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

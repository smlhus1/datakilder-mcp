import { test } from "node:test";
import assert from "node:assert/strict";
import { falskFetch, svar, verktoy } from "./hjelp/nett.mjs";

const { kart } = await import("../dist/sources/kart.js");
const { ogc } = await import("../dist/sources/ogc.js");

const CAPABILITIES =
  "<WMS_Capabilities><Service><Title>Topo</Title></Service><Capability>" +
  "<Request><GetFeatureInfo/></Request><Layer><Title>rot</Title>" +
  '<Layer queryable="1"><Name>topo</Name><Title>Topografisk</Title></Layer>' +
  "</Layer></Capability></WMS_Capabilities>";

const xml = (body) => svar(body, { headers: { "content-type": "text/xml" } });
const json = (body) => svar(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const INTERNE = [
  "http://127.0.0.1/",
  "http://localhost:9/",
  "http://169.254.169.254/latest/meta-data/",
  "http://10.0.0.1/",
  "http://172.16.0.1/",
  "http://192.168.1.1/",
  "http://100.100.1.1/", // CGNAT — Tailscale
  "http://0.0.0.0/",
  "http://[::1]/",
  "http://[fd00::1]/",
  "http://[fe80::1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://0x7f.1/", // the URL parser normalises these to 127.0.0.1 — check after parsing
  "http://2130706433/",
  "http://intern.example/", // a public-looking name that RESOLVES to a private address
];

test("S1: kart_lag, kart_punkt and ogc_punkt refuse internal hosts before any fetch", async (t) => {
  const kall = falskFetch(t, () => xml(CAPABILITIES), { "intern.example": "10.1.2.3" });

  for (const url of INTERNE) {
    await assert.rejects(verktoy(kart, "lag")({ url }), /intern adresse/, `kart_lag ${url}`);
    await assert.rejects(
      verktoy(kart, "punkt")({ url, lag: "x", lat: 59, lon: 11 }),
      /intern adresse/,
      `kart_punkt ${url}`,
    );
    await assert.rejects(verktoy(ogc, "punkt")({ tjeneste: url, lat: 59, lon: 11 }), undefined, `ogc_punkt ${url}`);
  }
  assert.deepEqual(
    kall.map((k) => k.url),
    [],
    "an internal host was fetched",
  );
});

test("S1b: IPv4-compatible IPv6 ([::127.0.0.1]) is refused", async (t) => {
  const kall = falskFetch(t, () => xml(CAPABILITIES));
  await assert.rejects(verktoy(kart, "lag")({ url: "http://[::127.0.0.1]/" }), /intern adresse/);
  assert.deepEqual(kall, []);
});

test("R1: DNS rebinding — a name that answers public, then private, never connects inside", async (t) => {
  // A TTL-0 rebinding host: the first lookup says public, every later one says
  // loopback. Checking one answer and connecting with another is the hole.
  const kall = falskFetch(t, () => xml(CAPABILITIES), { "rebind.example": ["151.101.1.1", "127.0.0.1"] });

  await verktoy(kart, "lag")({ url: "http://rebind.example/wms" }).catch(() => {});

  const inne = kall.filter((k) => k.adresse === "127.0.0.1").map((k) => k.url);
  assert.deepEqual(inne, [], "connected to 127.0.0.1 after the check had seen a public address");
});

test("R2: a connect-time answer in the blocklist is refused", async (t) => {
  const kall = falskFetch(t, () => xml(CAPABILITIES), { "intern2.example": "fd12::7" });
  await assert.rejects(verktoy(kart, "lag")({ url: "https://intern2.example/wms" }), /intern adresse/);
  assert.deepEqual(kall, []);
});

test("S2: a redirect from a public host to an internal one is not followed", async (t) => {
  const kall = falskFetch(t, (url) => {
    if (url.startsWith("https://wms.offentlig.example/")) {
      return svar(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
    }
    return xml("<secret/>");
  });

  await assert.rejects(verktoy(kart, "lag")({ url: "https://wms.offentlig.example/wms" }), /intern adresse/);
  assert.ok(
    kall.every((k) => !k.url.includes("127.0.0.1")),
    `followed the redirect: ${kall.map((k) => k.url).join(", ")}`,
  );
});

test("S3: a landingPageUri from the NGU index cannot point us inside", async (t) => {
  const kall = falskFetch(t, (url) => {
    if (url.startsWith("https://geo.ngu.no/api/features?")) {
      return json({ apis: [{ id: "x", title: "X", landingPageUri: "http://127.0.0.1/x" }] });
    }
    return json({ collections: [{ id: "c" }] });
  });

  await assert.rejects(verktoy(ogc, "punkt")({ tjeneste: "ngu:x", lat: 59, lon: 11 }));
  assert.ok(
    kall.every((k) => !k.url.includes("127.0.0.1")),
    `fetched ${kall.map((k) => k.url).join(", ")}`,
  );
});

test("public WMS still works, including a redirect to another public host", async (t) => {
  falskFetch(t, (url) => {
    if (url.startsWith("https://gammel.example/")) {
      return svar(null, { status: 301, headers: { location: "https://wms.geonorge.no/skwms1/wms.topo?flyttet=1" } });
    }
    if (url.startsWith("https://wms.geonorge.no/")) return xml(CAPABILITIES);
  });

  const direkte = await verktoy(kart, "lag")({ url: "https://wms.geonorge.no/skwms1/wms.topo" });
  assert.deepEqual(direkte.lag, [{ navn: "topo", tittel: "Topografisk" }]);

  const viaRedirect = await verktoy(kart, "lag")({ url: "https://gammel.example/wms" });
  assert.equal(viaRedirect.antallLag, 1);
});

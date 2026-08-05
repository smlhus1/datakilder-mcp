#!/usr/bin/env python3
"""Measure how much of data.norge.no is actually machine-readable.

Sample size matters: a 60-dataset sample moved from 94 % to 89 % between two runs,
because the catalogue does not return a stable order. 300 is large enough that the
figure holds still. Pass a different number as the first argument to check.

The question that decides build-vs-adopt: does a hit in the catalogue give you
DATA, or does it give you a link to a web page a human has to click? Sampling
beats guessing, so pull a real sample and classify the distribution URLs.

curl does the HTTP — python's TLS fails to these hosts on this macOS.
"""
import json
import re
import subprocess
import sys
from collections import Counter

SEARCH = "https://search.api.fellesdatakatalog.digdir.no/search/datasets"
RES = "https://resource.api.fellesdatakatalog.digdir.no/v1/datasets"
UA = "syncka-eval"

DATA_EXT = re.compile(
    r"\.(json|geojson|csv|tsv|xml|xlsx?|zip|gml|shp|ttl|rdf|nt|parquet|ndjson)(\?|$)", re.I
)
API_HINT = re.compile(r"(/api/|api\.|/wfs|/wms|service=w[mf]s|/rest/|/v\d+/|pxweb)", re.I)


def curl_json(url, post=None):
    cmd = ["curl", "-sS", "-m", "25", "-H", f"User-Agent: {UA}", "-H", "Accept: application/json"]
    if post is not None:
        cmd += ["-X", "POST", "-H", "Content-Type: application/json", "-d", json.dumps(post)]
    cmd.append(url)
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return None


def flatten(v):
    if isinstance(v, list):
        return v[0] if v else None
    return v


def classify(url):
    if not url:
        return "ingen url"
    if DATA_EXT.search(url):
        return "direkte datafil"
    if API_HINT.search(url):
        return "API-endepunkt"
    return "landingsside (HTML)"


def main(n=int(sys.argv[1]) if len(sys.argv) > 1 else 300):
    # Page through rather than asking for one huge page: the search API caps page
    # size, and a single call silently returned fewer rows than requested.
    hits, page = [], 0
    while len(hits) < n:
        res = curl_json(SEARCH, {"pagination": {"size": 100, "page": page}})
        if not res or not res.get("hits"):
            break
        hits.extend(res["hits"])
        if page >= res.get("page", {}).get("totalPages", 1) - 1:
            break
        page += 1
    if not hits:
        sys.exit("søk feilet")
    hits = hits[:n]
    print(f"katalogen totalt: {res['page']['totalElements']} datasett · utvalg: {len(hits)}\n")

    kinds, no_dist, with_download = Counter(), 0, 0
    for h in hits:
        r = curl_json(f"{RES}/{h['id']}")
        dists = (r or {}).get("distribution") or []
        if not dists:
            no_dist += 1
            continue
        for d in dists:
            dl, acc = flatten(d.get("downloadURL")), flatten(d.get("accessURL"))
            if dl:
                with_download += 1
            kinds[classify(dl or acc)] += 1

    total = sum(kinds.values())
    print(f"datasett uten distribusjon i det hele tatt: {no_dist}/{len(hits)}")
    print(f"distribusjoner totalt: {total} (med downloadURL: {with_download})\n")
    for k, v in kinds.most_common():
        print(f"  {k:22} {v:4}  {v / total * 100:5.1f} %")


if __name__ == "__main__":
    main()

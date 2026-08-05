/**
 * json-stat2 → labelled rows.
 *
 * Shared because SSB and Eurostat both speak it — the format is a statistics
 * standard, not an SSB quirk. Extracted from ssb.ts when Eurostat turned out to
 * return the identical shape: one fact, one place.
 *
 * The format stores values as a flat array plus the size of each dimension, so a
 * row's position is a mixed-radix number over those sizes. Doing that arithmetic
 * here means no caller — human or model — has to, and mixed-radix indexing is
 * exactly the kind of thing that goes subtly wrong rather than loudly wrong.
 */

export interface JsonStat2 {
  label?: string;
  value: Array<number | null> | Record<string, number | null>;
  id: string[];
  size: number[];
  dimension: Record<
    string,
    { label?: string; category: { index?: Record<string, number> | string[]; label?: Record<string, string> } }
  >;
}

export function flattenJsonStat(data: JsonStat2): Array<Record<string, string | number | null>> {
  const dims = data.id.map((id) => {
    const d = data.dimension[id];
    const byIndex: string[] = [];
    const index = d.category.index;

    if (Array.isArray(index)) {
      // Eurostat sometimes gives the category order as an array of codes.
      index.forEach((code, i) => (byIndex[i] = d.category.label?.[code] ?? code));
    } else {
      for (const [code, i] of Object.entries(index ?? {})) {
        byIndex[i] = d.category.label?.[code] ?? code;
      }
    }
    return { label: d.label ?? id, byIndex };
  });

  const total = data.size.reduce((a, b) => a * b, 1);

  // Values arrive either as a dense array (SSB) or a sparse object keyed by flat
  // index (Eurostat omits empty cells). Reading through a lookup handles both,
  // and a missing cell becomes null rather than shifting every later row.
  const at = (i: number): number | null =>
    Array.isArray(data.value) ? (data.value[i] ?? null) : (data.value[String(i)] ?? null);

  const rows: Array<Record<string, string | number | null>> = [];
  for (let flat = 0; flat < total; flat++) {
    const verdi = at(flat);
    if (verdi === null) continue; // skip empty cells rather than emit noise

    const row: Record<string, string | number | null> = {};
    let rest = flat;
    for (let d = dims.length - 1; d >= 0; d--) {
      const size = data.size[d];
      row[dims[d].label] = dims[d].byIndex[rest % size];
      rest = Math.floor(rest / size);
    }
    row.verdi = verdi;
    rows.push(row);
  }
  return rows;
}

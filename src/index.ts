#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SourceError } from "./source.js";
import { SOURCES } from "./sources/index.js";

/**
 * datakilder-mcp — typed access to Norwegian public data sources.
 *
 * Deliberately NOT a catalogue search. data.norge.no already has one, and a
 * sample of 60 datasets on 2026-08-05 showed 94 % of its download links pointing
 * at HTML landing pages rather than data. Discovery is the easy half; the hard
 * half is that every source has its own query shape. This server hides that
 * shape behind typed tools, one module per source.
 */

const server = new McpServer({ name: "datakilder", version: "0.1.0" });

/**
 * Register every tool from every source.
 *
 * Tool names are built as `<source>_<tool>` here rather than written out in each
 * module — so a source cannot accidentally collide with another's naming, and
 * renaming the scheme is a one-line change.
 */
for (const source of SOURCES) {
  for (const tool of source.tools) {
    server.registerTool(
      `${source.id}_${tool.name}`,
      {
        title: tool.title,
        description: `${tool.description}\n\nKilde: ${source.name}. Lisens: ${source.attribution.licence}.`,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown) => {
        try {
          const result = await tool.run(args);
          return {
            content: [
              {
                type: "text" as const,
                // Attribution travels with the data. Norwegian public data is
                // licensed, not public domain, and the credit line is useless
                // if it only lives in a README nobody reads at call time.
                text: JSON.stringify({ ...(result as object), _kilde: source.attribution.credit }, null, 2),
              },
            ],
          };
        } catch (err) {
          const message =
            err instanceof SourceError ? err.message : `Uventet feil: ${(err as Error).message}`;
          return { content: [{ type: "text" as const, text: message }], isError: true };
        }
      },
    );
  }
}

/** One overview tool so a caller can see what exists without reading the source. */
server.registerTool(
  "kilder",
  {
    title: "Hvilke datakilder er tilgjengelige?",
    description:
      "Lister kildene denne serveren dekker, med lisens, hjemmeside og hvilke verktøy hver kilde tilbyr.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          SOURCES.map((s) => ({
            id: s.id,
            navn: s.name,
            hjemmeside: s.homepage,
            lisens: s.attribution.licence,
            kreverNøkkel: s.requiresKeyEnv ?? false,
            tilgjengelig: !s.requiresKeyEnv || Boolean(process.env[s.requiresKeyEnv]),
            verktøy: s.tools.map((t) => `${s.id}_${t.name}`),
          })),
          null,
          2,
        ),
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());

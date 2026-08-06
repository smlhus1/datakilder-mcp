import type { ZodRawShape } from "zod";

/**
 * The contract every data source implements.
 *
 * The point of this file: adding source number six must mean writing ONE new file
 * and adding ONE line to the registry — never touching the server, the docs, or a
 * switch statement somewhere else. Everything the server needs (tool names, schemas,
 * licence text) is derived from these objects at startup.
 */

/** Terms we must pass on to whoever uses the data. Norwegian public data is rarely public domain. */
export interface Attribution {
  /** e.g. "NLOD 2.0", "CC BY 4.0" */
  licence: string;
  /** The credit line a consumer of this data has to reproduce. */
  credit: string;
  /** Where the terms are stated. */
  termsUrl: string;
}

export interface SourceTool {
  /** Tool name as exposed over MCP. Prefixed with the source id by the server. */
  name: string;
  title: string;
  /**
   * What the tool does — written for the model that has to pick it. Say what it
   * returns and what it needs, not what it is called.
   */
  description: string;
  inputSchema: ZodRawShape;
  /** Returns anything JSON-serialisable; the server handles wrapping and errors. */
  run: (args: any) => Promise<unknown>;
}

export interface Source {
  /** Short, stable, lowercase. Becomes the tool-name prefix (`ssb_tabell`). */
  id: string;
  name: string;
  homepage: string;
  attribution: Attribution;
  /**
   * Null when the API is open. Otherwise name the env var holding the key, so the
   * server can report which sources are unavailable instead of failing at call time.
   */
  requiresKeyEnv: string | null;
  tools: SourceTool[];
  /**
   * The cheapest call that proves this source is reachable right now, used by the
   * `doctor` tool.
   *
   * Declared by the source rather than kept in a list somewhere central: the
   * module knows which of its calls is cheap and which needs half a megabyte, and
   * a central list would drift the moment a tool is renamed. A source without one
   * is reported as unchecked — never as healthy.
   */
  helse?: { verktoy: string; args: Record<string, unknown> };
}

/** Error whose message is meant to be read by the model, not just logged. */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

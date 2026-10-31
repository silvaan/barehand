import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import type { Frame } from "../hal/types.js";
import type { ManualLibrary } from "../manuals.js";
import type { Session } from "../session.js";

export interface Ctx {
  server: McpServer;
  session: Session;
  config: Config;
  manuals: ManualLibrary;
}

export type Content = CallToolResult["content"][number];

export const text = (s: string): Content => ({ type: "text", text: s });

export const image = (f: Frame): Content => ({
  type: "image",
  data: f.png.toString("base64"),
  mimeType: "image/png",
});

export const json = (v: unknown): Content => text(JSON.stringify(v, null, 2));

/** Run a tool body and turn thrown errors into a readable tool error. */
export async function guarded(fn: () => Promise<Content[]>): Promise<CallToolResult> {
  try {
    return { content: await fn() };
  } catch (e) {
    return { isError: true, content: [text(`Error: ${(e as Error).message}`)] };
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

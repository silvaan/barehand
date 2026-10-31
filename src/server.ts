import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { ManualLibrary } from "./manuals.js";
import { Session } from "./session.js";
import { registerScreenTools } from "./tools/screen.js";
import { registerInputTools } from "./tools/input.js";
import { registerPowerTools } from "./tools/power.js";
import { registerConsoleTools } from "./tools/console.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import type { Ctx } from "./tools/common.js";
import { VERSION } from "./version.js";

export const INSTRUCTIONS = `barehand controls another computer out-of-band: its screen (capture card or VM), keyboard/mouse (USB HID), power button, boot media and a serial console. Nothing is installed on the target.
Work like a careful technician: look (screen_capture) before acting; use key_spam_until_change for POST hotkeys; once a rescue Linux is up, move to shell_exec and stop driving pixels. Never run destructive operations without a written plan the user approved (shell_exec_destructive). Identify the hardware early (hw_identify, or the BIOS main page) and consult the real manual (manual_fetch / manual_search) instead of guessing vendor-specific details. Load the "barehand" skill for playbooks.`;

export function createServer() {
  const { config } = loadConfig();
  const server = new McpServer({ name: "barehand", version: VERSION }, { instructions: INSTRUCTIONS });
  const session = new Session(config);
  const manuals = new ManualLibrary(path.join(config.workDir, "manuals"));
  const ctx: Ctx = { server, session, config, manuals };

  registerScreenTools(ctx);
  registerInputTools(ctx);
  registerPowerTools(ctx);
  registerConsoleTools(ctx);
  registerKnowledgeTools(ctx);

  return { server, session };
}

export async function serveStdio() {
  const { server, session } = createServer();
  const shutdown = async () => {
    await session.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
}

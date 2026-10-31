import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { classify, SNAPSHOT_COMMAND } from "../safety/guard.js";
import { guarded, json, sleep, text, type Ctx } from "./common.js";

const MAX_OUTPUT = 30000;

function clip(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  const half = MAX_OUTPUT / 2;
  return `${s.slice(0, half)}\n… [${s.length - MAX_OUTPUT} characters omitted] …\n${s.slice(-half)}`;
}

export function registerConsoleTools({ server, session, config }: Ctx) {
  server.registerTool(
    "console_read",
    {
      title: "Read the serial console",
      description:
        "Read raw text that arrived on the target's console (serial / USB CDC) since `since` (a cursor returned " +
        "by a previous call; 0 = everything buffered). Use it to see login prompts, kernel messages, GRUB on serial. " +
        "With `until` (a regex, e.g. \"login:\"), it returns as soon as that text shows up after `since`, waiting at " +
        "most wait_ms: use it to wait for a boot to finish without polling.",
      inputSchema: {
        since: z.number().int().min(0).default(0),
        max_bytes: z.number().int().min(256).max(200000).default(16384),
        wait_ms: z
          .number()
          .min(0)
          .max(600000)
          .default(0)
          .describe("wait this long for new data first (with `until`: at most this long)"),
        until: z.string().max(1000).optional().describe("regex (case-insensitive) to wait for"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ since, max_bytes, wait_ms, until }) =>
      guarded(async () => {
        const c = await session.requireConsole();
        let matched: boolean | undefined;
        if (until) matched = !!(await c.waitFor(new RegExp(until, "i"), since, wait_ms || 30000));
        else if (wait_ms) await sleep(wait_ms);
        const r = c.read(since, max_bytes);
        return [
          text(r.text || "(no data)"),
          json({ next_since: r.to, truncated: r.truncated, ...(until ? { matched } : {}) }),
        ];
      }),
  );

  server.registerTool(
    "console_send",
    {
      title: "Send raw text to the serial console",
      description:
        "Write text to the console as-is (add \\n to press Enter). For login prompts and interactive programs. " +
        "Escapes: \\x03 = Ctrl-C, \\x04 = Ctrl-D. Returns the cursor to read the reply from.",
      inputSchema: { data: z.string().min(1).max(10000) },
    },
    ({ data }) =>
      guarded(async () => {
        const c = await session.requireConsole();
        const findings = classify(data);
        if (findings.length) {
          throw new Error(
            `Refused: looks destructive (${findings.map((f) => f.rule).join(", ")}). Use shell_exec_destructive.`,
          );
        }
        const since = c.cursor;
        await c.write(data);
        return [json({ sent: data.length, since })];
      }),
  );

  server.registerTool(
    "shell_exec",
    {
      title: "Run a command on the target's shell",
      description:
        "Run a non-destructive shell command on the target over the console (a rescue Linux with a root shell on " +
        "the serial line) and return its output and exit code. Working directory and exports persist between " +
        "calls. Commands that can destroy data (mkfs, wipefs, dd to a device, partitioning, diskpart, …) are " +
        "refused here; use shell_exec_destructive.",
      inputSchema: {
        command: z.string().min(1).max(20000),
        timeout_s: z.number().min(1).max(3600).default(60),
      },
    },
    ({ command, timeout_s }) =>
      guarded(async () => {
        const findings = classify(command);
        if (findings.length) {
          return [
            text(
              "Refused: this command can destroy data.\n" +
                findings.map((f) => `- ${f.rule}: ${f.why} (\`${f.match}\`)`).join("\n") +
                "\nWrite a plan and use shell_exec_destructive.",
            ),
          ];
        }
        const c = await session.requireConsole();
        const r = await c.exec(command, timeout_s * 1000);
        if (r.timedOut) await c.interrupt();
        return [
          text(clip(r.output) || "(no output)"),
          json({ exit_code: r.exitCode, timed_out: r.timedOut, duration_ms: r.durationMs }),
        ];
      }),
  );

  server.registerTool(
    "shell_exec_destructive",
    {
      title: "Run a DESTRUCTIVE command on the target (needs approval)",
      description:
        "Run a command that can destroy data: formatting, partitioning, wiping, writing images, deleting boot " +
        "entries. Requires a plan in plain language and, for disk operations, the target disk's identity " +
        "(model, serial, size) taken from lsblk in this session. Before running, barehand saves a snapshot of " +
        "every partition table and the EFI boot entries. The user must approve every call: never batch " +
        "unrelated destructive steps into one call.",
      inputSchema: {
        command: z.string().min(1).max(20000),
        plan: z.string().min(20).describe("what will happen, why, and how to undo it if possible"),
        target_disk: z
          .object({ path: z.string(), model: z.string(), serial: z.string(), size: z.string() })
          .optional(),
        timeout_s: z.number().min(1).max(7200).default(600),
      },
      annotations: { destructiveHint: true },
    },
    ({ command, plan, target_disk, timeout_s }) =>
      guarded(async () => {
        const c = await session.requireConsole();

        // Verify the disk identity is still what the agent believes it is.
        if (target_disk) {
          const r = await c.exec(`lsblk -dno MODEL,SERIAL,SIZE ${JSON.stringify(target_disk.path)}`, 15000);
          const live = r.output.trim().replace(/\s+/g, " ");
          const ok = live.includes(target_disk.serial) && live.includes(target_disk.size);
          if (!ok) {
            throw new Error(
              `Disk identity mismatch for ${target_disk.path}: expected serial ${target_disk.serial} / size ` +
                `${target_disk.size}, found "${live}". Device names change between boots; re-check with lsblk.`,
            );
          }
        }

        // Ask the human through the MCP client when it supports elicitation.
        const caps = server.server.getClientCapabilities();
        if (caps?.elicitation) {
          const answer = await server.server.elicitInput({
            message:
              `barehand wants to run a DESTRUCTIVE command on the target.\n\nPlan:\n${plan}\n\n` +
              (target_disk ? `Disk: ${target_disk.path} · ${target_disk.model} · ${target_disk.serial} · ${target_disk.size}\n\n` : "") +
              `Command:\n${command}`,
            requestedSchema: {
              type: "object",
              properties: { confirm: { type: "boolean", title: "Run it", description: "Run this command now" } },
              required: ["confirm"],
            },
          });
          if (answer.action !== "accept" || answer.content?.confirm !== true) {
            return [text("Not run: the user declined.")];
          }
        }

        // Snapshot partition tables + boot entries before touching anything.
        const snap = await c.exec(SNAPSHOT_COMMAND, 60000);
        const dir = path.join(config.workDir, "snapshots");
        fs.mkdirSync(dir, { recursive: true });
        const snapFile = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
        fs.writeFileSync(snapFile, `# plan\n${plan}\n\n# command\n${command}\n\n${snap.output}`);

        const r = await c.exec(command, timeout_s * 1000);
        if (r.timedOut) await c.interrupt();
        return [
          text(clip(r.output) || "(no output)"),
          json({ exit_code: r.exitCode, timed_out: r.timedOut, duration_ms: r.durationMs, snapshot: snapFile }),
        ];
      }),
  );
}

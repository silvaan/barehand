import { z } from "zod";
import { parseCombo } from "../hal/keymap.js";
import { spamUntilChange, waitScreen } from "../screen.js";
import { guarded, image, json, text, type Ctx } from "./common.js";

export function registerScreenTools({ server, session, config }: Ctx) {
  server.registerTool(
    "screen_capture",
    {
      title: "Capture the target's screen",
      description:
        "Grab the current frame from the target's video output (BIOS, boot menu, installer, desktop). " +
        "Mouse coordinates for mouse_click refer to the pixel grid of the most recent capture.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      guarded(async () => {
        const f = await session.capture();
        return [image(f), text(`${f.width}x${f.height}`)];
      }),
  );

  server.registerTool(
    "screen_wait",
    {
      title: "Wait for the screen to change or settle",
      description:
        "Watch the screen server-side and return when it changes (until=change) or stops changing " +
        "(until=stable), then return that frame. Use after an action instead of capturing repeatedly: " +
        "e.g. wait for an installer step to finish drawing, or for POST to give way to the OS.",
      inputSchema: {
        until: z.enum(["change", "stable"]),
        timeout_s: z.number().min(1).max(1800).default(30),
        stable_ms: z.number().min(200).max(60000).default(1500).describe("until=stable: quiet period required"),
        threshold: z.number().min(0.001).max(0.5).default(0.02).describe("fraction of change that counts (0..1)"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ until, timeout_s, stable_ms, threshold }) =>
      guarded(async () => {
        const r = await waitScreen(session, { until, timeoutMs: timeout_s * 1000, stableMs: stable_ms, threshold });
        return [
          image(r.frame),
          json({ reached: r.reached, elapsed_ms: r.elapsedMs, max_diff: +r.maxDiff.toFixed(4), dark_fraction: +r.dark.toFixed(3) }),
        ];
      }),
  );

  server.registerTool(
    "key_spam_until_change",
    {
      title: "Tap a key until the screen changes (POST hotkeys)",
      description:
        "Repeatedly tap a key at hardware speed until the screen moves to a new, stable picture, then return it. " +
        "This is how to enter BIOS setup (del/f2/f10/f1/esc), the boot menu (f12/f11/f8/esc) or the GRUB menu " +
        "(esc/shift): the POST window is shorter than a model round-trip. Set before=power_on or before=reset to " +
        "start the boot from this call so no window is missed. Always inspect the returned frame: the change " +
        "may be the OS booting instead of the menu you wanted.",
      inputSchema: {
        key: z.string().describe('combo such as "del", "f2", "f12", "esc", "shift"'),
        before: z.enum(["none", "power_on", "reset"]).default("none"),
        interval_ms: z.number().min(30).max(2000).default(120),
        timeout_s: z.number().min(2).max(180).default(45),
        settle_ms: z.number().min(0).max(30000).default(0).describe("ignore changes during this initial period"),
      },
    },
    ({ key, before, interval_ms, timeout_s, settle_ms }) =>
      guarded(async () => {
        const stroke = parseCombo(key, "us");
        const r = await spamUntilChange(session, stroke, {
          before,
          intervalMs: interval_ms,
          timeoutMs: timeout_s * 1000,
          settleMs: settle_ms,
        });
        return [image(r.frame), json({ reached: r.reached, taps: r.taps, elapsed_ms: r.elapsedMs })];
      }),
  );

  server.registerTool(
    "session_status",
    {
      title: "Show the connection and capabilities",
      description:
        "Connect to the configured backend (if not yet) and report what it can do: screen, keyboard, mouse, " +
        "power, virtual media, console. Call this first in a session.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      guarded(async () => {
        const b = await session.get();
        const power = b.powerState && b.capabilities.powerSense ? await b.powerState().catch(() => "unknown") : "unknown";
        return [
          json({
            backend: b.name,
            capabilities: b.capabilities,
            power,
            console_cursor: session.console?.cursor ?? null,
            default_layout: config.layout,
            work_dir: config.workDir,
          }),
        ];
      }),
  );
}

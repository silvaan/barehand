import { z } from "zod";
import fs from "node:fs";
import { guarded, json, sleep, text, type Ctx } from "./common.js";

export function registerPowerTools({ server, session }: Ctx) {
  server.registerTool(
    "power_press",
    {
      title: "Press the power button",
      description:
        "Press the target's power button. A short press (default 300 ms) powers on, or asks the OS to shut down. " +
        "Holding >= 5000 ms forces power off: unsaved data on the target is lost, so prefer a clean shutdown.",
      inputSchema: { hold_ms: z.number().min(50).max(15000).default(300) },
      annotations: { destructiveHint: true },
    },
    ({ hold_ms }) =>
      guarded(async () => {
        const b = await session.require("pressPower", "power control", "Ask the human to press the power button.");
        await b.pressPower!(hold_ms);
        await sleep(500);
        const state = b.powerState && b.capabilities.powerSense ? await b.powerState() : "unknown";
        return [json({ pressed_ms: hold_ms, power: state })];
      }),
  );

  server.registerTool(
    "power_reset",
    {
      title: "Press the reset button",
      description: "Hard reset of the target (like the case reset button). Unsaved data is lost.",
      inputSchema: {},
      annotations: { destructiveHint: true },
    },
    () =>
      guarded(async () => {
        const b = await session.require("pressReset", "a reset button", "Use key_press ctrl+alt+del or power_press.");
        await b.pressReset!(300);
        return [text("reset pressed")];
      }),
  );

  server.registerTool(
    "power_state",
    {
      title: "Read whether the target is powered",
      description:
        "Read the power LED / VM state. Combine with screen_capture: 'on' with a black screen points at " +
        "video, RAM or POST problems; 'off' after pressing power points at the PSU, cabling or the board.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      guarded(async () => {
        const b = await session.require("powerState", "power sensing");
        return [json({ power: await b.powerState!() })];
      }),
  );

  server.registerTool(
    "media_attach",
    {
      title: "Insert a boot image (virtual media)",
      description:
        "Present a local ISO/IMG to the target as boot media (backends with virtual media only). For DIY hardware, " +
        "boot from the network or a Ventoy stick instead (see the skill).",
      inputSchema: { path: z.string() },
    },
    ({ path }) =>
      guarded(async () => {
        if (!fs.existsSync(path)) throw new Error(`No such file: ${path}`);
        const b = await session.require(
          "attachMedia",
          "virtual media",
          "Use network boot (iPXE) or a Ventoy USB stick for this hardware.",
        );
        await b.attachMedia!(path);
        return [text(`attached ${path}`)];
      }),
  );

  server.registerTool(
    "media_eject",
    {
      title: "Eject the boot image",
      description: "Remove the virtual media, e.g. after an install so the target boots from disk.",
      inputSchema: {},
    },
    () =>
      guarded(async () => {
        const b = await session.require("ejectMedia", "virtual media");
        await b.ejectMedia!();
        await sleep(200);
        return [text("ejected")];
      }),
  );
}

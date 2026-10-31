import { z } from "zod";
import { parseCombo, textToStrokes } from "../hal/keymap.js";
import { guarded, image, json, sleep, text, type Ctx } from "./common.js";

const layoutSchema = z
  .enum(["us", "abnt2"])
  .optional()
  .describe('Layout the target is interpreting keys with. BIOS, GRUB and boot menus are always "us".');

export function registerInputTools({ server, session, config }: Ctx) {
  server.registerTool(
    "key_press",
    {
      title: "Press keys or key combos",
      description:
        'Press a sequence of keys/combos, e.g. ["down","down","enter"], ["ctrl+alt+del"], ["f10","enter"], ' +
        '["win+r"]. Use "repeat" to press the whole sequence several times. Returns a screenshot afterwards ' +
        "unless capture=false.",
      inputSchema: {
        keys: z.array(z.string()).min(1).max(200),
        repeat: z.number().int().min(1).max(100).default(1),
        delay_ms: z.number().min(0).max(5000).default(80).describe("pause between key presses"),
        hold_ms: z.number().min(10).max(10000).default(40),
        layout: layoutSchema,
        capture: z.boolean().default(true),
        settle_ms: z.number().min(0).max(10000).default(400).describe("wait before the screenshot"),
      },
    },
    ({ keys, repeat, delay_ms, hold_ms, layout, capture, settle_ms }) =>
      guarded(async () => {
        const b = await session.get();
        const strokes = keys.map((k) => parseCombo(k, layout ?? "us"));
        for (let r = 0; r < repeat; r++) {
          for (const s of strokes) {
            await b.tap(s, hold_ms);
            if (delay_ms) await sleep(delay_ms);
          }
        }
        if (!capture) return [text(`pressed ${strokes.length * repeat} keys`)];
        await sleep(settle_ms);
        return [image(await session.capture())];
      }),
  );

  server.registerTool(
    "key_hold",
    {
      title: "Hold or release a key",
      description:
        "Hold a key down (action=down) or release it (action=up), or release everything (action=release_all). " +
        "For things like holding Shift during boot or the power-on of a Mac-style keyboard shortcut.",
      inputSchema: {
        action: z.enum(["down", "up", "release_all"]),
        key: z.string().optional(),
      },
    },
    ({ action, key }) =>
      guarded(async () => {
        const b = await session.get();
        if (action === "release_all") await b.releaseAll();
        else {
          if (!key) throw new Error("key is required for down/up");
          const s = parseCombo(key, "us");
          if (action === "down") await b.keyDown(s);
          else await b.keyUp(s);
        }
        return [text("ok")];
      }),
  );

  server.registerTool(
    "type_text",
    {
      title: "Type text on the target keyboard",
      description:
        "Type literal text (newlines press Enter). Pick the layout the target is using: the OS's layout once " +
        'installed (e.g. "abnt2"), "us" in BIOS/GRUB/installer first screens. Prefer shell_exec once a console ' +
        "is available; it is faster and verifiable.",
      inputSchema: {
        text: z.string().min(1).max(20000),
        layout: layoutSchema,
        delay_ms: z.number().min(0).max(1000).default(15),
        capture: z.boolean().default(false),
      },
    },
    ({ text: t, layout, delay_ms, capture }) =>
      guarded(async () => {
        const b = await session.get();
        const strokes = textToStrokes(t, layout ?? config.layout);
        for (const s of strokes) {
          await b.tap(s, 25);
          if (delay_ms) await sleep(delay_ms);
        }
        const out = [text(`typed ${t.length} characters (${strokes.length} strokes, layout ${layout ?? config.layout})`)];
        if (capture) {
          await sleep(300);
          out.unshift(image(await session.capture()));
        }
        return out;
      }),
  );

  server.registerTool(
    "mouse_click",
    {
      title: "Move the mouse and click",
      description:
        "Click at pixel (x, y) of the most recent screenshot (absolute pointer). Many BIOS setups ignore " +
        "absolute pointers: prefer keyboard navigation there. button=none just moves.",
      inputSchema: {
        x: z.number().min(0),
        y: z.number().min(0),
        button: z.enum(["left", "right", "middle", "none"]).default("left"),
        double: z.boolean().default(false),
        capture: z.boolean().default(true),
      },
    },
    ({ x, y, button, double, capture }) =>
      guarded(async () => {
        const b = await session.require("mouseMoveAbs", "an absolute mouse");
        const ref = session.lastFrame ?? (await session.capture());
        await b.mouseMoveAbs!(x / ref.width, y / ref.height);
        if (button !== "none") {
          for (let i = 0; i < (double ? 2 : 1); i++) {
            await sleep(40);
            await b.mouseButton!(button, true);
            await sleep(60);
            await b.mouseButton!(button, false);
          }
        }
        if (!capture) return [text("ok")];
        await sleep(400);
        return [image(await session.capture())];
      }),
  );

  server.registerTool(
    "mouse_scroll",
    {
      title: "Scroll the mouse wheel",
      description: "Scroll by `clicks` wheel notches (positive = up).",
      inputSchema: { clicks: z.number().int().min(-50).max(50) },
    },
    ({ clicks }) =>
      guarded(async () => {
        const b = await session.get();
        if (!b.mouseWheel) throw new Error(`Backend "${b.name}" has no mouse wheel`);
        await b.mouseWheel(clicks);
        return [json({ scrolled: clicks })];
      }),
  );
}

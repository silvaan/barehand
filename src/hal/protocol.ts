/**
 * Line protocol between the host and the barehand firmware (see docs/protocol.md).
 *
 * Host -> device: one ASCII command per line, hex for HID values.
 * Device -> host: "OK [data]" / "ERR <msg>" answer commands in order;
 *                 "CD <base64>" carries console bytes from the target at any time;
 *                 "EV <name> <value>" reports asynchronous events.
 */
import type { KeyStroke } from "./types.js";

const hex = (n: number) => n.toString(16).padStart(2, "0");

export const cmd = {
  ping: () => "PING",
  keyDown: (s: KeyStroke) => `KD ${hex(s.mods)} ${hex(s.usage)}`,
  keyUp: (s: KeyStroke) => `KU ${hex(s.mods)} ${hex(s.usage)}`,
  keyTap: (s: KeyStroke, holdMs: number) => `KT ${hex(s.mods)} ${hex(s.usage)} ${Math.round(holdMs)}`,
  releaseAll: () => "KR",
  mouseRel: (dx: number, dy: number) => `MR ${Math.round(dx)} ${Math.round(dy)}`,
  /** x, y in 0..32767 */
  mouseAbs: (x: number, y: number) => `MA ${Math.round(x)} ${Math.round(y)}`,
  /** bit0 left, bit1 right, bit2 middle */
  mouseButtons: (mask: number) => `MB ${mask & 7}`,
  mouseWheel: (delta: number) => `MW ${Math.round(delta)}`,
  powerPress: (ms: number) => `PP ${Math.round(ms)}`,
  resetPress: (ms: number) => `PR ${Math.round(ms)}`,
  powerSense: () => "PS",
  consoleWrite: (data: Buffer) => `CW ${data.toString("base64")}`,
};

export type DeviceLine =
  | { kind: "ok"; data: string }
  | { kind: "err"; message: string }
  | { kind: "console"; data: Buffer }
  | { kind: "event"; name: string; value: string }
  | { kind: "log"; text: string };

export function parseDeviceLine(line: string): DeviceLine {
  const l = line.replace(/\r$/, "");
  if (l === "OK" || l.startsWith("OK ")) return { kind: "ok", data: l.slice(3) };
  if (l.startsWith("ERR")) return { kind: "err", message: l.slice(4) || "unknown error" };
  if (l.startsWith("CD ")) return { kind: "console", data: Buffer.from(l.slice(3), "base64") };
  if (l.startsWith("EV ")) {
    const [, name = "", ...rest] = l.split(" ");
    return { kind: "event", name, value: rest.join(" ") };
  }
  return { kind: "log", text: l };
}

/** Max raw console bytes per CW line (keeps lines well under the firmware buffer). */
export const CONSOLE_CHUNK = 192;

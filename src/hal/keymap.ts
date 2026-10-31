/**
 * Text and key-combo translation to USB HID usages.
 *
 * HID sends *physical key positions*, not characters. What character appears
 * depends on the layout the target is interpreting the keyboard with:
 * - BIOS/UEFI setup, GRUB, boot menus and most installers' first screens: US.
 * - An installed OS: whatever layout it was configured with (e.g. ABNT2).
 *
 * So translation happens on the host, per call, and the firmware only ever
 * receives (usage, modifiers) pairs.
 */
import { KeyStroke, Mod } from "./types.js";

export type Layout = "us" | "abnt2";

const k = (usage: number, mods = 0): KeyStroke => ({ usage, mods });
const S = Mod.LShift;

/** Named (non-character) keys, accepted in combos like "ctrl+alt+del". */
export const NAMED_KEYS: Record<string, number> = {
  enter: 0x28, return: 0x28,
  esc: 0x29, escape: 0x29,
  backspace: 0x2a, bksp: 0x2a,
  tab: 0x2b,
  space: 0x2c,
  capslock: 0x39,
  f1: 0x3a, f2: 0x3b, f3: 0x3c, f4: 0x3d, f5: 0x3e, f6: 0x3f,
  f7: 0x40, f8: 0x41, f9: 0x42, f10: 0x43, f11: 0x44, f12: 0x45,
  printscreen: 0x46, prtsc: 0x46,
  scrolllock: 0x47,
  pause: 0x48, break: 0x48,
  insert: 0x49, ins: 0x49,
  home: 0x4a,
  pageup: 0x4b, pgup: 0x4b,
  delete: 0x4c, del: 0x4c,
  end: 0x4d,
  pagedown: 0x4e, pgdn: 0x4e,
  right: 0x4f, left: 0x50, down: 0x51, up: 0x52,
  numlock: 0x53,
  menu: 0x65, application: 0x65,
};

const MODIFIER_NAMES: Record<string, number> = {
  ctrl: Mod.LCtrl, control: Mod.LCtrl, lctrl: Mod.LCtrl, rctrl: Mod.RCtrl,
  shift: Mod.LShift, lshift: Mod.LShift, rshift: Mod.RShift,
  alt: Mod.LAlt, lalt: Mod.LAlt, ralt: Mod.RAlt, altgr: Mod.RAlt,
  win: Mod.LGui, super: Mod.LGui, meta: Mod.LGui, cmd: Mod.LGui, gui: Mod.LGui,
};

function letterUsage(ch: string): number {
  return 0x04 + (ch.charCodeAt(0) - "a".charCodeAt(0));
}

/** Characters common to US and ABNT2 (same physical key, same output). */
function baseMap(): Map<string, KeyStroke[]> {
  const m = new Map<string, KeyStroke[]>();
  for (let c = 0; c < 26; c++) {
    const lower = String.fromCharCode(97 + c);
    m.set(lower, [k(letterUsage(lower))]);
    m.set(lower.toUpperCase(), [k(letterUsage(lower), S)]);
  }
  "1234567890".split("").forEach((d, i) => m.set(d, [k(0x1e + i)]));
  m.set(" ", [k(0x2c)]);
  m.set("\n", [k(0x28)]);
  m.set("\t", [k(0x2b)]);
  m.set("-", [k(0x2d)]);
  m.set("_", [k(0x2d, S)]);
  m.set("=", [k(0x2e)]);
  m.set("+", [k(0x2e, S)]);
  m.set(",", [k(0x36)]);
  m.set("<", [k(0x36, S)]);
  m.set(".", [k(0x37)]);
  m.set(">", [k(0x37, S)]);
  // Shifted digits shared by both layouts.
  m.set("!", [k(0x1e, S)]);
  m.set("@", [k(0x1f, S)]);
  m.set("#", [k(0x20, S)]);
  m.set("$", [k(0x21, S)]);
  m.set("%", [k(0x22, S)]);
  m.set("&", [k(0x24, S)]);
  m.set("*", [k(0x25, S)]);
  m.set("(", [k(0x26, S)]);
  m.set(")", [k(0x27, S)]);
  return m;
}

function usMap(): Map<string, KeyStroke[]> {
  const m = baseMap();
  m.set("^", [k(0x23, S)]);
  m.set("[", [k(0x2f)]);
  m.set("{", [k(0x2f, S)]);
  m.set("]", [k(0x30)]);
  m.set("}", [k(0x30, S)]);
  m.set("\\", [k(0x31)]);
  m.set("|", [k(0x31, S)]);
  m.set(";", [k(0x33)]);
  m.set(":", [k(0x33, S)]);
  m.set("'", [k(0x34)]);
  m.set('"', [k(0x34, S)]);
  m.set("`", [k(0x35)]);
  m.set("~", [k(0x35, S)]);
  m.set("/", [k(0x38)]);
  m.set("?", [k(0x38, S)]);
  return m;
}

function abnt2Map(): Map<string, KeyStroke[]> {
  const m = baseMap();
  const SPACE = k(0x2c);
  // Dead keys on ABNT2.
  const ACUTE = k(0x2f);
  const GRAVE = k(0x2f, S);
  const TILDE = k(0x34);
  const CIRC = k(0x34, S);
  const DIAER = k(0x23, S);

  m.set("'", [k(0x35)]);
  m.set('"', [k(0x35, S)]);
  m.set("[", [k(0x30)]);
  m.set("{", [k(0x30, S)]);
  m.set("]", [k(0x32)]);
  m.set("}", [k(0x32, S)]);
  m.set("\\", [k(0x64)]);
  m.set("|", [k(0x64, S)]);
  m.set(";", [k(0x38)]);
  m.set(":", [k(0x38, S)]);
  m.set("/", [k(0x87)]);
  m.set("?", [k(0x87, S)]);
  m.set("ç", [k(0x33)]);
  m.set("Ç", [k(0x33, S)]);
  // Literal dead-key characters: dead key followed by space.
  m.set("´", [ACUTE, SPACE]);
  m.set("`", [GRAVE, SPACE]);
  m.set("~", [TILDE, SPACE]);
  m.set("^", [CIRC, SPACE]);
  m.set("¨", [DIAER, SPACE]);

  const compose: Array<[KeyStroke, string, string]> = [
    [ACUTE, "aeiou", "áéíóú"],
    [GRAVE, "aeiou", "àèìòù"],
    [CIRC, "aeiou", "âêîôû"],
    [TILDE, "aon", "ãõñ"],
    [DIAER, "aeiou", "äëïöü"],
  ];
  for (const [dead, bases, outs] of compose) {
    for (let i = 0; i < bases.length; i++) {
      const b = bases[i]!;
      const o = outs[i]!;
      m.set(o, [dead, k(letterUsage(b))]);
      m.set(o.toUpperCase(), [dead, k(letterUsage(b), S)]);
    }
  }
  return m;
}

const LAYOUTS: Record<Layout, Map<string, KeyStroke[]>> = {
  us: usMap(),
  abnt2: abnt2Map(),
};

export class UntypeableError extends Error {
  constructor(readonly chars: string[], layout: Layout) {
    super(
      `Cannot type ${chars.map((c) => JSON.stringify(c)).join(", ")} with layout "${layout}".`,
    );
    this.name = "UntypeableError";
  }
}

/** Translate text to a sequence of key strokes for the given target layout. */
export function textToStrokes(text: string, layout: Layout = "us"): KeyStroke[] {
  const map = LAYOUTS[layout];
  const out: KeyStroke[] = [];
  const missing = new Set<string>();
  for (const ch of text.replace(/\r\n?/g, "\n")) {
    const seq = map.get(ch);
    if (seq) out.push(...seq);
    else missing.add(ch);
  }
  if (missing.size) throw new UntypeableError([...missing], layout);
  return out;
}

/**
 * Parse a combo such as "ctrl+alt+del", "F12", "shift+tab", "win+r".
 * A single printable character is also accepted ("y", "1").
 */
export function parseCombo(combo: string, layout: Layout = "us"): KeyStroke {
  const parts = combo
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (combo.trim() === "+") return textToStrokes("+", layout)[0]!;
  if (parts.length === 0) throw new Error(`Empty key combo: "${combo}"`);

  let mods = 0;
  const keyName = parts.pop()!;
  for (const p of parts) {
    const m = MODIFIER_NAMES[p];
    if (m === undefined) throw new Error(`Unknown modifier "${p}" in "${combo}"`);
    mods |= m;
  }

  if (MODIFIER_NAMES[keyName] !== undefined && parts.length === 0) {
    // A bare modifier tap (e.g. "win" to open the Start menu).
    return { usage: 0, mods: MODIFIER_NAMES[keyName]! };
  }
  const named = NAMED_KEYS[keyName];
  if (named !== undefined) return { usage: named, mods };

  const strokes = textToStrokes(keyName.length === 1 ? keyName : "", layout);
  if (strokes.length !== 1) throw new Error(`Unknown key "${keyName}" in "${combo}"`);
  const s = strokes[0]!;
  return { usage: s.usage, mods: s.mods | mods };
}

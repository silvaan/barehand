import { describe, expect, it } from "vitest";
import { parseCombo, textToStrokes, UntypeableError } from "../src/hal/keymap.js";
import { Mod } from "../src/hal/types.js";

describe("textToStrokes", () => {
  it("types lowercase, uppercase and digits on US", () => {
    expect(textToStrokes("aZ1", "us")).toEqual([
      { usage: 0x04, mods: 0 },
      { usage: 0x1d, mods: Mod.LShift },
      { usage: 0x1e, mods: 0 },
    ]);
  });

  it("maps US punctuation", () => {
    expect(textToStrokes("/", "us")).toEqual([{ usage: 0x38, mods: 0 }]);
    expect(textToStrokes(":", "us")).toEqual([{ usage: 0x33, mods: Mod.LShift }]);
    expect(textToStrokes("|", "us")).toEqual([{ usage: 0x31, mods: Mod.LShift }]);
  });

  it("maps ABNT2 positions that differ from US", () => {
    expect(textToStrokes("/", "abnt2")).toEqual([{ usage: 0x87, mods: 0 }]);
    expect(textToStrokes(";", "abnt2")).toEqual([{ usage: 0x38, mods: 0 }]);
    expect(textToStrokes("ç", "abnt2")).toEqual([{ usage: 0x33, mods: 0 }]);
    expect(textToStrokes('"', "abnt2")).toEqual([{ usage: 0x35, mods: Mod.LShift }]);
    expect(textToStrokes("|", "abnt2")).toEqual([{ usage: 0x64, mods: Mod.LShift }]);
  });

  it("composes ABNT2 accents with dead keys", () => {
    expect(textToStrokes("ã", "abnt2")).toEqual([
      { usage: 0x34, mods: 0 },
      { usage: 0x04, mods: 0 },
    ]);
    expect(textToStrokes("É", "abnt2")).toEqual([
      { usage: 0x2f, mods: 0 },
      { usage: 0x08, mods: Mod.LShift },
    ]);
    // Literal tilde = dead key + space.
    expect(textToStrokes("~", "abnt2")).toEqual([
      { usage: 0x34, mods: 0 },
      { usage: 0x2c, mods: 0 },
    ]);
  });

  it("types a realistic shell command on both layouts", () => {
    const cmd = "grub-install --target=x86_64-efi --efi-directory=/boot/efi\n";
    expect(() => textToStrokes(cmd, "us")).not.toThrow();
    expect(() => textToStrokes(cmd, "abnt2")).not.toThrow();
  });

  it("reports untypeable characters", () => {
    expect(() => textToStrokes("ç", "us")).toThrow(UntypeableError);
  });
});

describe("parseCombo", () => {
  it("parses named keys and modifiers", () => {
    expect(parseCombo("ctrl+alt+del")).toEqual({ usage: 0x4c, mods: Mod.LCtrl | Mod.LAlt });
    expect(parseCombo("F12")).toEqual({ usage: 0x45, mods: 0 });
    expect(parseCombo("shift+tab")).toEqual({ usage: 0x2b, mods: Mod.LShift });
    expect(parseCombo("win+r")).toEqual({ usage: 0x15, mods: Mod.LGui });
  });

  it("accepts a bare modifier", () => {
    expect(parseCombo("shift")).toEqual({ usage: 0, mods: Mod.LShift });
  });

  it("accepts single characters, including +", () => {
    expect(parseCombo("y")).toEqual({ usage: 0x1c, mods: 0 });
    expect(parseCombo("+")).toEqual({ usage: 0x2e, mods: Mod.LShift });
  });

  it("rejects unknown keys", () => {
    expect(() => parseCombo("hyper+x")).toThrow();
    expect(() => parseCombo("banana")).toThrow();
  });
});

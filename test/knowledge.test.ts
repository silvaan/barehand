import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findChecksum } from "../src/download.js";
import { htmlToText, ManualLibrary, paginate } from "../src/manuals.js";
import { cmd, parseDeviceLine } from "../src/hal/protocol.js";

describe("findChecksum", () => {
  const h = "a".repeat(64);
  it("reads GNU and BSD formats", () => {
    expect(findChecksum(`${h} *ubuntu-24.04.1-desktop-amd64.iso\n`, "ubuntu-24.04.1-desktop-amd64.iso")).toBe(h);
    expect(findChecksum(`${"b".repeat(64)}  other.iso\n${h}  debian.iso`, "debian.iso")).toBe(h);
    expect(findChecksum(`SHA256 (Fedora.iso) = ${h.toUpperCase()}`, "Fedora.iso")).toBe(h);
    expect(findChecksum(`${h}  x.iso`, "y.iso")).toBeUndefined();
  });
});

describe("manuals", () => {
  it("converts HTML and paginates on paragraph boundaries", () => {
    expect(htmlToText("<p>Front&nbsp;panel</p><script>x()</script><p>header</p>")).toBe("Front panel\nheader");
    const pages = paginate(Array.from({ length: 10 }, (_, i) => `para ${i} ${"x".repeat(900)}`).join("\n\n"), 2000);
    expect(pages.length).toBeGreaterThan(3);
    expect(pages.every((p) => p.length <= 2000)).toBe(true);
  });

  it("ranks pages that match every term", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bh-manuals-"));
    const dir = path.join(root, "b450");
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: "b450", title: "B450 manual", url: "x", kind: "pdf", pages: 3, fetchedAt: "", tags: [] }),
    );
    fs.writeFileSync(
      path.join(dir, "pages.json"),
      JSON.stringify([
        "Installing memory modules into the DIMM slots.",
        "System panel connector (F_PANEL): PWR_SW, RESET_SW, PLED+ and PLED-. Front panel header pinout.",
        "Q-LED: the CPU, DRAM, VGA and BOOT LEDs light up during POST.",
      ]),
    );
    const lib = new ManualLibrary(root);
    const hits = lib.search("front panel header");
    expect(hits[0]).toMatchObject({ manual: "b450", page: 2 });
    expect(lib.search("q-led dram")[0]?.page).toBe(3);
  });
});

describe("firmware protocol", () => {
  it("encodes commands and parses device lines", () => {
    expect(cmd.keyTap({ usage: 0x4c, mods: 0x05 }, 40)).toBe("KT 05 4c 40");
    expect(cmd.consoleWrite(Buffer.from("ls\n"))).toBe("CW bHMK");
    expect(parseDeviceLine("OK barehand-fw 0.1.0\r")).toEqual({ kind: "ok", data: "barehand-fw 0.1.0" });
    expect(parseDeviceLine("ERR bad usage")).toEqual({ kind: "err", message: "bad usage" });
    expect(parseDeviceLine("CD aGk=")).toEqual({ kind: "console", data: Buffer.from("hi") });
    expect(parseDeviceLine("EV PLED 1")).toEqual({ kind: "event", name: "PLED", value: "1" });
  });
});

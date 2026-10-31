/**
 * QEMU backend — the development lab.
 *
 * Drives a local VM through QMP exactly like real hardware would drive a PC:
 * screendump = capture card, input-send-event = USB HID, a serial chardev =
 * USB CDC console, blockdev-change-medium = virtual media. Start the VM with
 * `lab/run-target.sh`, which wires up the sockets this backend expects.
 */
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { QmpClient } from "./qmp.js";
import { pngSize, ppmToPng } from "../util/frames.js";
import type { Backend, Capabilities, Frame, KeyStroke, MouseButton, PowerState } from "./types.js";
import { Mod } from "./types.js";

export interface QemuOptions {
  qmp: string; // unix socket path or host:port
  serial?: string; // unix socket path or host:port of the serial chardev
  cdromId?: string; // qdev id of the CD-ROM drive
}

/** HID usage -> QEMU QKeyCode. */
const QCODE: Record<number, string> = {
  0x28: "ret", 0x29: "esc", 0x2a: "backspace", 0x2b: "tab", 0x2c: "spc",
  0x2d: "minus", 0x2e: "equal", 0x2f: "bracket_left", 0x30: "bracket_right",
  0x31: "backslash", 0x32: "backslash", 0x33: "semicolon", 0x34: "apostrophe",
  0x35: "grave_accent", 0x36: "comma", 0x37: "dot", 0x38: "slash",
  0x39: "caps_lock", 0x46: "print", 0x47: "scroll_lock", 0x48: "pause",
  0x49: "insert", 0x4a: "home", 0x4b: "pgup", 0x4c: "delete", 0x4d: "end",
  0x4e: "pgdn", 0x4f: "right", 0x50: "left", 0x51: "down", 0x52: "up",
  0x53: "num_lock", 0x64: "less", 0x65: "menu", 0x87: "ro",
};
for (let i = 0; i < 26; i++) QCODE[0x04 + i] = String.fromCharCode(97 + i);
for (let i = 0; i < 9; i++) QCODE[0x1e + i] = String(i + 1);
QCODE[0x27] = "0";
for (let i = 0; i < 12; i++) QCODE[0x3a + i] = `f${i + 1}`;

const MOD_QCODES: Array<[number, string]> = [
  [Mod.LCtrl, "ctrl"], [Mod.LShift, "shift"], [Mod.LAlt, "alt"], [Mod.LGui, "meta_l"],
  [Mod.RCtrl, "ctrl_r"], [Mod.RShift, "shift_r"], [Mod.RAlt, "alt_r"], [Mod.RGui, "meta_r"],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class QemuBackend implements Backend {
  readonly name = "qemu";
  readonly capabilities: Capabilities;
  private qmp: QmpClient;
  private serialSock?: net.Socket;
  private consoleListeners = new Set<(d: Buffer) => void>();
  private held = new Set<string>();
  /** Emulated "hard off": VM paused by us after a long power press. */
  private forcedOff = false;
  /** QEMU < 7.1 rejects screendump's "format" argument and only writes PPM. */
  private ppmOnly = false;

  constructor(private readonly opts: QemuOptions) {
    this.qmp = new QmpClient({ address: opts.qmp });
    this.capabilities = {
      screen: true,
      keyboard: true,
      mouseRelative: true,
      mouseAbsolute: true, // requires -device usb-tablet (lab script adds it)
      power: true,
      powerSense: true,
      virtualMedia: true,
      console: Boolean(opts.serial),
    };
  }

  async connect() {
    await this.qmp.connect();
    if (this.opts.serial) {
      const addr = this.opts.serial;
      const tcp = /^[^/]+:\d+$/.test(addr);
      this.serialSock = tcp
        ? net.connect(Number(addr.split(":").pop()), addr.slice(0, addr.lastIndexOf(":")))
        : net.connect(addr);
      await new Promise<void>((resolve, reject) => {
        this.serialSock!.once("connect", resolve);
        this.serialSock!.once("error", (e) => reject(new Error(`Cannot connect to serial at ${addr}: ${e.message}`)));
      });
      this.serialSock.on("data", (d: Buffer) => this.consoleListeners.forEach((l) => l(d)));
    }
  }

  async close() {
    await this.releaseAll().catch(() => {});
    this.serialSock?.end();
    this.qmp.close();
  }

  async capture(): Promise<Frame> {
    const file = path.join(os.tmpdir(), `barehand-qemu-${process.pid}-${Date.now()}.img`);
    try {
      if (!this.ppmOnly) {
        try {
          await this.qmp.execute("screendump", { filename: file, format: "png" });
        } catch (e) {
          if (!/format/i.test(String((e as Error).message))) throw e;
          this.ppmOnly = true;
        }
      }
      if (this.ppmOnly) await this.qmp.execute("screendump", { filename: file });
      const raw = await fs.readFile(file);
      const png = this.ppmOnly ? ppmToPng(raw) : raw;
      const { width, height } = pngSize(png);
      return { png, width, height, capturedAt: Date.now() };
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  private keyEvents(stroke: KeyStroke, down: boolean) {
    const codes: string[] = [];
    for (const [bit, q] of MOD_QCODES) if (stroke.mods & bit) codes.push(q);
    if (stroke.usage) {
      const q = QCODE[stroke.usage];
      if (!q) throw new Error(`No QEMU qcode for HID usage 0x${stroke.usage.toString(16)}`);
      codes.push(q);
    }
    // Press modifiers first, release them last.
    const ordered = down ? codes : [...codes].reverse();
    return ordered.map((q) => {
      if (down) this.held.add(q);
      else this.held.delete(q);
      return { type: "key", data: { down, key: { type: "qcode", data: q } } };
    });
  }

  async keyDown(stroke: KeyStroke) {
    await this.qmp.execute("input-send-event", { events: this.keyEvents(stroke, true) });
  }

  async keyUp(stroke: KeyStroke) {
    await this.qmp.execute("input-send-event", { events: this.keyEvents(stroke, false) });
  }

  async tap(stroke: KeyStroke, holdMs = 30) {
    await this.keyDown(stroke);
    await sleep(holdMs);
    await this.keyUp(stroke);
  }

  async releaseAll() {
    const events = [...this.held].map((q) => ({ type: "key", data: { down: false, key: { type: "qcode", data: q } } }));
    this.held.clear();
    if (events.length) await this.qmp.execute("input-send-event", { events });
  }

  async mouseMoveAbs(x: number, y: number) {
    const v = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 32767);
    await this.qmp.execute("input-send-event", {
      events: [
        { type: "abs", data: { axis: "x", value: v(x) } },
        { type: "abs", data: { axis: "y", value: v(y) } },
      ],
    });
  }

  async mouseMoveRel(dx: number, dy: number) {
    await this.qmp.execute("input-send-event", {
      events: [
        { type: "rel", data: { axis: "x", value: Math.round(dx) } },
        { type: "rel", data: { axis: "y", value: Math.round(dy) } },
      ],
    });
  }

  async mouseButton(button: MouseButton, down: boolean) {
    await this.qmp.execute("input-send-event", { events: [{ type: "btn", data: { down, button } }] });
  }

  async mouseWheel(delta: number) {
    const button = delta > 0 ? "wheel-up" : "wheel-down";
    for (let i = 0; i < Math.abs(Math.round(delta)); i++) {
      await this.qmp.execute("input-send-event", { events: [{ type: "btn", data: { down: true, button } }] });
      await this.qmp.execute("input-send-event", { events: [{ type: "btn", data: { down: false, button } }] });
    }
  }

  /**
   * Power button emulation (VM must run with -no-shutdown):
   * - short press while on  -> ACPI power button (OS decides what to do)
   * - long press (>=4s) on  -> hard off (VM paused, reported as "off")
   * - any press while off   -> cold boot (reset + continue)
   */
  async pressPower(holdMs: number) {
    const state = await this.powerState();
    if (state === "off") {
      this.forcedOff = false;
      await this.qmp.execute("system_reset");
      await this.qmp.execute("cont");
      return;
    }
    if (holdMs >= 4000) {
      await sleep(holdMs);
      await this.qmp.execute("stop");
      this.forcedOff = true;
      return;
    }
    await this.qmp.execute("system_powerdown");
  }

  async pressReset() {
    await this.qmp.execute("system_reset");
  }

  async powerState(): Promise<PowerState> {
    const st = await this.qmp.execute<{ running: boolean; status: string }>("query-status");
    if (this.forcedOff || st.status === "shutdown") return "off";
    if (st.running) return "on";
    return "unknown";
  }

  async attachMedia(imagePath: string) {
    await this.qmp.execute("blockdev-change-medium", {
      id: this.opts.cdromId ?? "cd0",
      filename: path.resolve(imagePath),
      format: "raw",
    });
  }

  async ejectMedia() {
    await this.qmp.execute("eject", { id: this.opts.cdromId ?? "cd0", force: true });
  }

  async consoleWrite(data: Buffer) {
    if (!this.serialSock) throw new Error("No serial console configured");
    this.serialSock.write(data);
  }

  onConsoleData(listener: (d: Buffer) => void) {
    this.consoleListeners.add(listener);
    return () => this.consoleListeners.delete(listener);
  }
}

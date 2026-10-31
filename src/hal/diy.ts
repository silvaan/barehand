/**
 * DIY backend: USB capture card + ESP32-S3 running firmware/esp32s3-hid.
 *
 * Eyes: any UVC device through ffmpeg. Hands, power and console: the ESP32's
 * UART link (see docs/protocol.md). Boot media is not emulated; use network
 * boot or a Ventoy stick (docs/hardware.md).
 */
import { SerialPort } from "serialport";
import { VideoCapture, type CaptureOptions } from "./capture.js";
import { cmd, parseDeviceLine, CONSOLE_CHUNK } from "./protocol.js";
import type { Backend, Capabilities, Frame, KeyStroke, MouseButton, PowerState } from "./types.js";

export interface DiyOptions {
  serialPort: string; // e.g. /dev/ttyUSB0, COM5
  baud?: number;
  video: CaptureOptions;
  /** Set false if the front-panel header isn't wired. */
  power?: boolean;
}

type Waiter = { resolve: (data: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

export class DiyBackend implements Backend {
  readonly name = "diy";
  capabilities: Capabilities;
  private port?: SerialPort;
  private video: VideoCapture;
  private rx = "";
  private queue: Waiter[] = [];
  private consoleListeners = new Set<(d: Buffer) => void>();
  private buttons = 0;
  firmware = "";

  constructor(private readonly opts: DiyOptions) {
    this.video = new VideoCapture(opts.video);
    this.capabilities = {
      screen: true,
      keyboard: true,
      mouseRelative: true,
      mouseAbsolute: true,
      power: opts.power ?? true,
      powerSense: opts.power ?? true,
      virtualMedia: false,
      console: true,
    };
  }

  async connect() {
    this.port = new SerialPort({ path: this.opts.serialPort, baudRate: this.opts.baud ?? 921600, autoOpen: false });
    await new Promise<void>((resolve, reject) =>
      this.port!.open((e) => (e ? reject(new Error(`Cannot open ${this.opts.serialPort}: ${e.message}`)) : resolve())),
    );
    this.port.on("data", (d: Buffer) => this.onData(d));
    this.port.on("close", () => this.failAll(new Error("Serial link closed")));
    // Opening the port may reset the board; give it a moment, then handshake.
    await sleep(300);
    this.firmware = await this.send(cmd.ping(), 3000);
    this.video.start();
  }

  async close() {
    await this.releaseAll().catch(() => {});
    this.video.stop();
    await new Promise<void>((r) => (this.port?.isOpen ? this.port.close(() => r()) : r()));
  }

  private onData(d: Buffer) {
    this.rx += d.toString("latin1");
    let nl: number;
    while ((nl = this.rx.indexOf("\n")) >= 0) {
      const line = this.rx.slice(0, nl);
      this.rx = this.rx.slice(nl + 1);
      const msg = parseDeviceLine(line);
      if (msg.kind === "console") this.consoleListeners.forEach((l) => l(msg.data));
      else if (msg.kind === "ok" || msg.kind === "err") {
        const w = this.queue.shift();
        if (!w) continue;
        clearTimeout(w.timer);
        if (msg.kind === "ok") w.resolve(msg.data);
        else w.reject(new Error(`Firmware: ${msg.message}`));
      }
    }
  }

  private failAll(e: Error) {
    for (const w of this.queue.splice(0)) {
      clearTimeout(w.timer);
      w.reject(e);
    }
  }

  private send(line: string, timeoutMs = 2000): Promise<string> {
    if (!this.port?.isOpen) return Promise.reject(new Error("DIY backend not connected"));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.queue.findIndex((w) => w.timer === timer);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error(`Firmware did not answer "${line.slice(0, 20)}" within ${timeoutMs} ms`));
      }, timeoutMs);
      this.queue.push({ resolve, reject, timer });
      this.port!.write(line + "\n");
    });
  }

  capture(): Promise<Frame> {
    return this.video.frame();
  }

  async tap(stroke: KeyStroke, holdMs = 30) {
    await this.send(cmd.keyTap(stroke, holdMs), 2000 + holdMs);
  }
  async keyDown(stroke: KeyStroke) {
    await this.send(cmd.keyDown(stroke));
  }
  async keyUp(stroke: KeyStroke) {
    await this.send(cmd.keyUp(stroke));
  }
  async releaseAll() {
    this.buttons = 0;
    await this.send(cmd.releaseAll());
  }

  async mouseMoveAbs(x: number, y: number) {
    const v = (n: number) => Math.min(1, Math.max(0, n)) * 32767;
    await this.send(cmd.mouseAbs(v(x), v(y)));
  }
  async mouseMoveRel(dx: number, dy: number) {
    await this.send(cmd.mouseRel(dx, dy));
  }
  async mouseButton(button: MouseButton, down: boolean) {
    this.buttons = down ? this.buttons | BUTTON_BITS[button] : this.buttons & ~BUTTON_BITS[button];
    await this.send(cmd.mouseButtons(this.buttons));
  }
  async mouseWheel(delta: number) {
    await this.send(cmd.mouseWheel(delta));
  }

  async pressPower(holdMs: number) {
    await this.send(cmd.powerPress(holdMs), holdMs + 2000);
  }
  async pressReset(holdMs: number) {
    await this.send(cmd.resetPress(holdMs), holdMs + 2000);
  }
  async powerState(): Promise<PowerState> {
    const v = (await this.send(cmd.powerSense())).trim();
    return v === "1" ? "on" : v === "0" ? "off" : "unknown";
  }

  async consoleWrite(data: Buffer) {
    for (let i = 0; i < data.length; i += CONSOLE_CHUNK) {
      await this.send(cmd.consoleWrite(data.subarray(i, i + CONSOLE_CHUNK)));
    }
  }
  onConsoleData(listener: (d: Buffer) => void) {
    this.consoleListeners.add(listener);
    return () => this.consoleListeners.delete(listener);
  }
}

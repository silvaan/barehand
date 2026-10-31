/**
 * One live connection to one target machine, created lazily on first use so
 * the MCP server starts (and can explain what's wrong) even with no hardware.
 */
import fs from "node:fs";
import type { Config } from "./config.js";
import type { Backend, Frame } from "./hal/types.js";
import { UnsupportedError } from "./hal/types.js";
import { QemuBackend } from "./hal/qemu.js";
import { DiyBackend } from "./hal/diy.js";
import { Console } from "./console.js";

export class Session {
  private backend?: Backend;
  private connecting?: Promise<Backend>;
  /** The last frame shown to the agent: mouse pixel coordinates refer to it. */
  lastFrame?: Frame;
  console?: Console;

  constructor(readonly config: Config) {
    fs.mkdirSync(config.workDir, { recursive: true });
  }

  createBackend(): Backend {
    const c = this.config;
    if (c.backend === "qemu") return new QemuBackend(c.qemu);
    if (!c.diy) throw new Error("backend is \"diy\" but no diy config was given");
    return new DiyBackend(c.diy);
  }

  async get(): Promise<Backend> {
    if (this.backend) return this.backend;
    this.connecting ??= (async () => {
      const b = this.createBackend();
      try {
        await b.connect();
      } catch (e) {
        this.connecting = undefined;
        throw e;
      }
      this.backend = b;
      if (b.capabilities.console) this.console = new Console(b);
      return b;
    })();
    return this.connecting;
  }

  async require<K extends keyof Backend>(method: K, capability: string, hint?: string) {
    const b = await this.get();
    if (typeof b[method] !== "function" || !this.hasCapability(b, method)) {
      throw new UnsupportedError(b.name, capability, hint);
    }
    return b;
  }

  private hasCapability(b: Backend, method: keyof Backend): boolean {
    const c = b.capabilities;
    switch (method) {
      case "pressPower":
      case "pressReset":
        return c.power;
      case "powerState":
        return c.powerSense;
      case "attachMedia":
      case "ejectMedia":
        return c.virtualMedia;
      case "mouseMoveAbs":
        return c.mouseAbsolute;
      case "mouseMoveRel":
        return c.mouseRelative;
      case "consoleWrite":
      case "onConsoleData":
        return c.console;
      default:
        return true;
    }
  }

  async requireConsole(): Promise<Console> {
    await this.get();
    if (!this.console) {
      throw new UnsupportedError(this.backend!.name, "a console", "Configure a serial console for this backend.");
    }
    return this.console;
  }

  async capture(): Promise<Frame> {
    const f = await (await this.get()).capture();
    this.lastFrame = f;
    return f;
  }

  async close() {
    await this.backend?.close();
    this.backend = undefined;
    this.connecting = undefined;
  }
}

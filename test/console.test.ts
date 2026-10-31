import { describe, expect, it } from "vitest";
import { Console, stripAnsi } from "../src/console.js";
import type { Backend } from "../src/hal/types.js";

/**
 * A fake target: a line-oriented "shell" that understands the exact wrapper
 * Console.exec sends, so the marker protocol is tested end to end.
 */
function fakeShell(run: (cmd: string) => { out: string; code: number }): Backend {
  const listeners = new Set<(d: Buffer) => void>();
  const emit = (s: string) => setTimeout(() => listeners.forEach((l) => l(Buffer.from(s))), 1);
  let pending = "";
  return {
    name: "fake",
    capabilities: { screen: false, keyboard: false, mouseRelative: false, mouseAbsolute: false, power: false, powerSense: false, virtualMedia: false, console: true },
    async connect() {},
    async close() {},
    async capture() {
      throw new Error("no screen");
    },
    async tap() {},
    async keyDown() {},
    async keyUp() {},
    async releaseAll() {},
    async consoleWrite(data: Buffer) {
      pending += data.toString();
      // prepareShell
      const ready = /echo (READY_[0-9a-f]+)\n/.exec(pending);
      if (ready) {
        pending = "";
        emit(`\x1b[0m${ready[1]}\r\n`);
        return;
      }
      const m = /echo (__BH_S_\w+__); \{ ([\s\S]*)\n\} 2>&1 <\/dev\/null; echo "(__BH_E_\w+_)\$\?__"\n/.exec(pending);
      if (m) {
        pending = "";
        const r = run(m[2]!);
        emit(`${m[1]}\n`);
        emit(r.out);
        emit(`${m[3]}${r.code}__\n`);
      }
    },
    onConsoleData(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

describe("Console.exec", () => {
  it("returns output and exit code between markers", async () => {
    const c = new Console(fakeShell((cmd) => ({ out: `ran: ${cmd}\n`, code: cmd.includes("false") ? 1 : 0 })));
    const ok = await c.exec("lsblk", 2000);
    expect(ok).toMatchObject({ exitCode: 0, output: "ran: lsblk\n", timedOut: false });
    const bad = await c.exec("false", 2000);
    expect(bad.exitCode).toBe(1);
  });

  it("times out cleanly when the shell never answers", async () => {
    const c = new Console(fakeShell(() => ({ out: "", code: 0 })));
    await c.prepareShell();
    // Swallow everything from now on.
    (c as unknown as { backend: Backend }).backend.consoleWrite = async () => {};
    const r = await c.exec("sleep 999", 200);
    expect(r).toMatchObject({ exitCode: null, timedOut: true });
  });

  it("keeps a readable cursor-based log", async () => {
    const c = new Console(fakeShell(() => ({ out: "hello\n", code: 0 })));
    const before = c.cursor;
    await c.exec("echo hello", 2000);
    expect(c.read(before).text).toContain("hello");
    expect(c.read(c.cursor).text).toBe("");
  });
});

describe("stripAnsi", () => {
  it("removes CSI colours and systemd's OSC 3008 context markers", () => {
    const raw =
      "\x1b]3008;start=6d71;user=root;type=session\x1b\\\x1b]3008;start=6a56;type=shell\x07" +
      "\x1b[1;31m[root@sysrescue ~]#\x1b[0m \r\n";
    expect(stripAnsi(raw)).toBe("[root@sysrescue ~]# \n");
  });
});

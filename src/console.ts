/**
 * Text console to the target (serial / USB CDC), plus reliable command
 * execution on a POSIX shell running on it.
 *
 * `exec` turns an interactive shell into something like a remote procedure
 * call: it wraps the command, appends a unique end marker carrying the exit
 * status and returns the output in between.
 */
import { randomBytes } from "node:crypto";
import type { Backend } from "./hal/types.js";

const MAX_BUFFER = 1 << 20; // keep the last 1 MiB

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>]|\r/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

export interface ExecResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export class Console {
  private buf: Buffer = Buffer.alloc(0);
  /** Absolute offset of buf[0] in the stream since the session started. */
  private base = 0;
  private listeners = new Set<() => void>();
  private shellPrepared = false;

  constructor(private readonly backend: Backend) {
    backend.onConsoleData!((d) => {
      this.buf = Buffer.concat([this.buf, d]);
      if (this.buf.length > MAX_BUFFER) {
        const drop = this.buf.length - MAX_BUFFER;
        this.buf = this.buf.subarray(drop);
        this.base += drop;
      }
      this.listeners.forEach((l) => l());
    });
  }

  /** Absolute offset of the end of the stream. */
  get cursor(): number {
    return this.base + this.buf.length;
  }

  read(since = 0, maxBytes = 16384): { text: string; from: number; to: number; truncated: boolean } {
    const start = Math.max(since, this.base);
    let slice = this.buf.subarray(start - this.base);
    let from = start;
    let truncated = since < this.base;
    if (slice.length > maxBytes) {
      slice = slice.subarray(slice.length - maxBytes);
      from = this.cursor - maxBytes;
      truncated = true;
    }
    return { text: stripAnsi(slice.toString("utf8")), from, to: this.cursor, truncated };
  }

  async write(text: string) {
    await this.backend.consoleWrite!(Buffer.from(text, "utf8"));
  }

  /** Wait until `pattern` appears in the stream after `since`. */
  waitFor(pattern: RegExp, since: number, timeoutMs: number): Promise<RegExpExecArray | null> {
    return new Promise((resolve) => {
      const check = () => {
        const m = pattern.exec(stripAnsi(this.buf.subarray(Math.max(0, since - this.base)).toString("utf8")));
        if (m) {
          done(m);
          return true;
        }
        return false;
      };
      const done = (m: RegExpExecArray | null) => {
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(m);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      if (!check()) this.listeners.add(check);
    });
  }

  /** Make the shell quiet and machine-friendly. Safe to call repeatedly. */
  async prepareShell(force = false) {
    if (this.shellPrepared && !force) return;
    const nonce = randomBytes(4).toString("hex");
    const since = this.cursor;
    await this.write(
      "\x03\n" + // abandon any half-typed line
        "stty -echo -onlcr cols 250 2>/dev/null; export PS1= PS2= TERM=dumb PAGER=cat SYSTEMD_PAGER= " +
        `LC_ALL=C; unset PROMPT_COMMAND; echo READY_${nonce}\n`,
    );
    const ok = await this.waitFor(new RegExp(`READY_${nonce}`), since, 5000);
    if (!ok) {
      throw new Error(
        "No shell answered on the console. Is a rescue system booted and logged in? " +
          "Use console_read to see what is on the line.",
      );
    }
    this.shellPrepared = true;
  }

  async exec(command: string, timeoutMs = 60000): Promise<ExecResult> {
    await this.prepareShell();
    const nonce = randomBytes(6).toString("hex");
    const start = `__BH_S_${nonce}__`;
    const end = `__BH_E_${nonce}_`;
    const since = this.cursor;
    const t0 = Date.now();
    // Braces (not a subshell) so `cd` and exports persist between calls.
    await this.write(`echo ${start}; { ${command}\n} 2>&1 </dev/null; echo "${end}$?__"\n`);
    const pattern = new RegExp(`${start}\\n([\\s\\S]*?)${end}(\\d+)__`);
    const m = await this.waitFor(pattern, since, timeoutMs);
    if (!m) {
      const partial = this.read(since).text;
      const i = partial.indexOf(start);
      return {
        exitCode: null,
        output: i >= 0 ? partial.slice(i + start.length + 1) : partial,
        timedOut: true,
        durationMs: Date.now() - t0,
      };
    }
    return { exitCode: Number(m[2]), output: m[1]!, timedOut: false, durationMs: Date.now() - t0 };
  }

  /** Send Ctrl-C, e.g. after a timed-out command. */
  async interrupt() {
    await this.write("\x03");
  }
}

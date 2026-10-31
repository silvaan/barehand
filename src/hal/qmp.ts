/** Minimal QEMU Machine Protocol client (JSON lines over a unix/TCP socket). */
import net from "node:net";
import { EventEmitter } from "node:events";

export interface QmpEndpoint {
  /** unix socket path, or "host:port" for TCP */
  address: string;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class QmpClient extends EventEmitter {
  private sock?: net.Socket;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private greeted?: () => void;

  constructor(private readonly endpoint: QmpEndpoint) {
    super();
  }

  async connect(timeoutMs = 5000): Promise<void> {
    const { address } = this.endpoint;
    const tcp = /^[^/]+:\d+$/.exec(address);
    const sock = tcp
      ? net.connect(Number(address.split(":").pop()), address.slice(0, address.lastIndexOf(":")))
      : net.connect(address);
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => this.onData(d));
    sock.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("QMP connection closed"));
      this.pending.clear();
      this.emit("close");
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`QMP greeting timeout on ${address}`)), timeoutMs);
      sock.once("error", (e) => {
        clearTimeout(t);
        reject(new Error(`Cannot connect to QMP at ${address}: ${e.message}`));
      });
      this.greeted = () => {
        clearTimeout(t);
        resolve();
      };
    });
    await this.execute("qmp_capabilities");
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if ("QMP" in msg) {
        this.greeted?.();
      } else if ("event" in msg) {
        this.emit("event", msg);
      } else if ("id" in msg) {
        const p = this.pending.get(msg.id as number);
        if (!p) continue;
        this.pending.delete(msg.id as number);
        if ("error" in msg) {
          const err = msg.error as { class?: string; desc?: string };
          p.reject(new Error(`QMP ${err.class ?? "Error"}: ${err.desc ?? "unknown"}`));
        } else {
          p.resolve(msg.return);
        }
      }
    }
  }

  execute<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.sock) return Promise.reject(new Error("QMP not connected"));
    const id = this.nextId++;
    const payload = JSON.stringify(args ? { execute: command, arguments: args, id } : { execute: command, id });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.sock!.write(payload + "\n");
    });
  }

  close() {
    this.sock?.end();
    this.sock = undefined;
  }
}

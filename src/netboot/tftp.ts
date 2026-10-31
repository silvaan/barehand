/**
 * Read-only TFTP server (RFC 1350) with blksize/tsize/timeout options
 * (RFC 2347/2348/2349) — enough for PXE ROMs to fetch iPXE (~1 MB).
 */
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import { bindUdp } from "./dhcp.js";

const OP = { RRQ: 1, WRQ: 2, DATA: 3, ACK: 4, ERROR: 5, OACK: 6 } as const;

/** Return the file's bytes, or undefined if it doesn't exist. */
export type TftpResolver = (name: string, client: { address: string; port: number }) => Buffer | undefined;

export function parseRrq(msg: Buffer): { file: string; mode: string; options: Record<string, string> } | undefined {
  if (msg.readUInt16BE(0) !== OP.RRQ) return undefined;
  const parts = msg.subarray(2).toString("latin1").split("\0");
  const [file, mode] = parts;
  if (!file || !mode) return undefined;
  const options: Record<string, string> = {};
  for (let i = 2; i + 1 < parts.length; i += 2) if (parts[i]) options[parts[i]!.toLowerCase()] = parts[i + 1]!;
  return { file, mode: mode.toLowerCase(), options };
}

function errorPacket(code: number, message: string): Buffer {
  const b = Buffer.alloc(5 + Buffer.byteLength(message));
  b.writeUInt16BE(OP.ERROR, 0);
  b.writeUInt16BE(code, 2);
  b.write(message, 4, "latin1");
  return b;
}

export interface TftpOptions {
  resolve: TftpResolver;
  bind?: string;
  port?: number; // 69
  retries?: number;
}

export class TftpServer extends EventEmitter {
  private sock?: dgram.Socket;

  constructor(private readonly opts: TftpOptions) {
    super();
  }

  get port(): number | undefined {
    return this.sock?.address().port;
  }

  async start() {
    this.sock = await bindUdp(this.opts.port ?? 69, this.opts.bind ?? "0.0.0.0", false);
    this.sock.on("message", (msg, rinfo) => {
      const rrq = msg.length >= 4 ? parseRrq(msg) : undefined;
      if (!rrq) {
        this.sock!.send(errorPacket(4, "only read requests are supported"), rinfo.port, rinfo.address);
        return;
      }
      void this.transfer(rrq, rinfo);
    });
  }

  private async transfer(rrq: NonNullable<ReturnType<typeof parseRrq>>, client: dgram.RemoteInfo) {
    const name = rrq.file.replace(/^\/+/, "");
    const data = this.opts.resolve(name, client);
    const s = dgram.createSocket("udp4");
    await new Promise<void>((r) => s.bind(0, () => r()));
    const send = (b: Buffer) => s.send(b, client.port, client.address);
    const done = (ok: boolean, why?: string) => {
      this.emit("transfer", { file: name, client: client.address, ok, bytes: data?.length ?? 0, why });
      s.close();
    };

    if (!data) {
      send(errorPacket(1, "file not found"));
      return done(false, "not found");
    }

    // Option negotiation.
    let blksize = 512;
    let timeoutMs = 1000;
    const oack: string[] = [];
    if (rrq.options.blksize) {
      blksize = Math.max(8, Math.min(Number(rrq.options.blksize) || 512, 1468));
      oack.push("blksize", String(blksize));
    }
    if (rrq.options.tsize !== undefined) oack.push("tsize", String(data.length));
    if (rrq.options.timeout) {
      const t = Math.max(1, Math.min(Number(rrq.options.timeout) || 1, 10));
      timeoutMs = t * 1000;
      oack.push("timeout", String(t));
    }

    const retries = this.opts.retries ?? 5;
    const waitAck = (block: number, packet: Buffer): Promise<"ack" | "error" | "timeout"> =>
      new Promise((resolve) => {
        let tries = 0;
        const onMsg = (m: Buffer, r: dgram.RemoteInfo) => {
          if (r.port !== client.port || r.address !== client.address || m.length < 4) return;
          const op = m.readUInt16BE(0);
          if (op === OP.ERROR) return finish("error");
          if (op === OP.ACK && m.readUInt16BE(2) === (block & 0xffff)) finish("ack");
        };
        const timer = setInterval(() => {
          if (++tries > retries) return finish("timeout");
          send(packet);
        }, timeoutMs);
        const finish = (v: "ack" | "error" | "timeout") => {
          clearInterval(timer);
          s.off("message", onMsg);
          resolve(v);
        };
        s.on("message", onMsg);
        send(packet);
      });

    if (oack.length) {
      const pkt = Buffer.concat([Buffer.from([0, OP.OACK]), Buffer.from(oack.join("\0") + "\0", "latin1")]);
      const r = await waitAck(0, pkt);
      // Many UEFI clients ask for tsize, then abort and re-request: not an error.
      if (r !== "ack") return done(false, r === "error" ? "client aborted after OACK" : "timeout");
    }

    for (let block = 1, off = 0; ; block++, off += blksize) {
      const chunk = data.subarray(off, off + blksize);
      const pkt = Buffer.alloc(4 + chunk.length);
      pkt.writeUInt16BE(OP.DATA, 0);
      pkt.writeUInt16BE(block & 0xffff, 2); // rolls over past 65535, as clients expect
      chunk.copy(pkt, 4);
      const r = await waitAck(block, pkt);
      if (r !== "ack") return done(false, r);
      if (chunk.length < blksize) return done(true);
    }
  }

  stop() {
    this.sock?.close();
    this.sock = undefined;
  }
}

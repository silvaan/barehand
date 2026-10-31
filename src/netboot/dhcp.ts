/**
 * ProxyDHCP for PXE (Intel PXE spec 2.1 + UEFI HTTP Boot).
 *
 * A proxyDHCP server never hands out addresses: the LAN's normal DHCP server
 * (the home router) keeps doing that. We only answer PXE clients, telling
 * them where the boot file is. That means no router configuration and no
 * conflict with existing DHCP.
 *
 * Flow:   client --DISCOVER(PXEClient)--> broadcast :67
 *         router --OFFER(ip)-->            client
 *         us     --OFFER(no ip, bootfile)-> client           (port 67, broadcast)
 *         client --REQUEST-->              us :4011          (UEFI/iPXE, "BINL")
 *         us     --ACK(bootfile)-->        client
 */
import dgram from "node:dgram";
import { EventEmitter } from "node:events";

export const MAGIC = 0x63825363;

export const MsgType = { DISCOVER: 1, OFFER: 2, REQUEST: 3, DECLINE: 4, ACK: 5, NAK: 6, RELEASE: 7, INFORM: 8 } as const;

export const Opt = {
  PAD: 0,
  TFTP_SERVER: 66,
  BOOTFILE: 67,
  MSG_TYPE: 53,
  SERVER_ID: 54,
  VENDOR_CLASS: 60,
  VENDOR_SPECIFIC: 43,
  USER_CLASS: 77,
  CLIENT_ARCH: 93,
  CLIENT_UUID: 97,
  END: 255,
} as const;

/** RFC 4578 client system architecture types. */
export const Arch = { BIOS: 0, EFI_IA32: 6, EFI_BC: 7, EFI_X64: 9, EFI_X64_HTTP: 16 } as const;

export interface DhcpPacket {
  op: number;
  htype: number;
  hlen: number;
  hops: number;
  xid: number;
  secs: number;
  flags: number;
  ciaddr: string;
  yiaddr: string;
  siaddr: string;
  giaddr: string;
  chaddr: Buffer; // 16 bytes
  sname: string;
  file: string;
  options: Map<number, Buffer>;
}

const ip2buf = (ip: string) => Buffer.from(ip.split(".").map(Number));
const buf2ip = (b: Buffer) => [...b].join(".");
const cstr = (b: Buffer) => {
  const i = b.indexOf(0);
  return b.subarray(0, i < 0 ? b.length : i).toString("latin1");
};

export function parseDhcp(buf: Buffer): DhcpPacket {
  if (buf.length < 240 || buf.readUInt32BE(236) !== MAGIC) throw new Error("not a DHCP packet");
  const options = new Map<number, Buffer>();
  let i = 240;
  while (i < buf.length) {
    const code = buf[i]!;
    if (code === Opt.PAD) {
      i++;
      continue;
    }
    if (code === Opt.END) break;
    const len = buf[i + 1]!;
    const data = buf.subarray(i + 2, i + 2 + len);
    // Options may be split across several instances (RFC 3396): concatenate.
    options.set(code, options.has(code) ? Buffer.concat([options.get(code)!, data]) : Buffer.from(data));
    i += 2 + len;
  }
  return {
    op: buf[0]!,
    htype: buf[1]!,
    hlen: buf[2]!,
    hops: buf[3]!,
    xid: buf.readUInt32BE(4),
    secs: buf.readUInt16BE(8),
    flags: buf.readUInt16BE(10),
    ciaddr: buf2ip(buf.subarray(12, 16)),
    yiaddr: buf2ip(buf.subarray(16, 20)),
    siaddr: buf2ip(buf.subarray(20, 24)),
    giaddr: buf2ip(buf.subarray(24, 28)),
    chaddr: Buffer.from(buf.subarray(28, 44)),
    sname: cstr(buf.subarray(44, 108)),
    file: cstr(buf.subarray(108, 236)),
    options,
  };
}

export function buildDhcp(p: DhcpPacket): Buffer {
  const opts: Buffer[] = [];
  for (const [code, data] of p.options) {
    for (let off = 0; off < data.length || off === 0; off += 255) {
      const part = data.subarray(off, off + 255);
      opts.push(Buffer.from([code, part.length]), part);
      if (data.length === 0) break;
    }
  }
  const head = Buffer.alloc(240);
  head[0] = p.op;
  head[1] = p.htype;
  head[2] = p.hlen;
  head[3] = p.hops;
  head.writeUInt32BE(p.xid >>> 0, 4);
  head.writeUInt16BE(p.secs, 8);
  head.writeUInt16BE(p.flags, 10);
  ip2buf(p.ciaddr).copy(head, 12);
  ip2buf(p.yiaddr).copy(head, 16);
  ip2buf(p.siaddr).copy(head, 20);
  ip2buf(p.giaddr).copy(head, 24);
  p.chaddr.copy(head, 28, 0, 16);
  head.write(p.sname.slice(0, 63), 44, "latin1");
  if (Buffer.byteLength(p.file) > 127) throw new Error(`boot file name too long for BOOTP: ${p.file}`);
  head.write(p.file, 108, "latin1");
  head.writeUInt32BE(MAGIC, 236);
  return Buffer.concat([head, ...opts, Buffer.from([Opt.END])]);
}

export interface PxeClientInfo {
  mac: string;
  arch: number | undefined;
  vendorClass: string;
  isIpxe: boolean;
  uuid?: Buffer;
}

export function clientInfo(p: DhcpPacket): PxeClientInfo {
  const archOpt = p.options.get(Opt.CLIENT_ARCH);
  return {
    mac: [...p.chaddr.subarray(0, p.hlen || 6)].map((b) => b.toString(16).padStart(2, "0")).join(":"),
    arch: archOpt && archOpt.length >= 2 ? archOpt.readUInt16BE(0) : undefined,
    vendorClass: p.options.get(Opt.VENDOR_CLASS)?.toString("latin1") ?? "",
    isIpxe: p.options.get(Opt.USER_CLASS)?.toString("latin1").includes("iPXE") ?? false,
    uuid: p.options.get(Opt.CLIENT_UUID),
  };
}

export interface BootChoice {
  /** TFTP file name or http:// URL */
  file: string;
  /** "PXEClient" for TFTP boot, "HTTPClient" for UEFI HTTP Boot */
  vendorClass: "PXEClient" | "HTTPClient";
}

/** Decide what to give a client; undefined = not ours to answer. */
export type BootPolicy = (c: PxeClientInfo) => BootChoice | undefined;

export function proxyReply(req: DhcpPacket, type: number, serverIp: string, choice: BootChoice): Buffer {
  const options = new Map<number, Buffer>();
  options.set(Opt.MSG_TYPE, Buffer.from([type]));
  options.set(Opt.SERVER_ID, ip2buf(serverIp));
  options.set(Opt.VENDOR_CLASS, Buffer.from(choice.vendorClass));
  const uuid = req.options.get(Opt.CLIENT_UUID);
  if (uuid) options.set(Opt.CLIENT_UUID, uuid);
  if (choice.vendorClass === "PXEClient") {
    // PXE_DISCOVERY_CONTROL (sub-option 6) = 0x08: "boot file name is present, download it
    // directly", with no boot-server discovery or menu.
    options.set(Opt.VENDOR_SPECIFIC, Buffer.from([6, 1, 0x08, 255]));
    options.set(Opt.TFTP_SERVER, Buffer.from(serverIp));
  }
  options.set(Opt.BOOTFILE, Buffer.from(choice.file));
  return buildDhcp({
    op: 2,
    htype: req.htype,
    hlen: req.hlen,
    hops: 0,
    xid: req.xid,
    secs: 0,
    flags: req.flags | 0x8000,
    ciaddr: "0.0.0.0",
    yiaddr: "0.0.0.0",
    siaddr: serverIp,
    giaddr: req.giaddr,
    chaddr: req.chaddr,
    sname: serverIp,
    file: choice.file,
    options,
  });
}

export interface ProxyDhcpOptions {
  serverIp: string;
  policy: BootPolicy;
  /** Bind address for both sockets (default 0.0.0.0, needed to see broadcasts). */
  bind?: string;
  port?: number; // 67
  binlPort?: number; // 4011
}

export class ProxyDhcpServer extends EventEmitter {
  private sock67?: dgram.Socket;
  private sock4011?: dgram.Socket;

  constructor(private readonly opts: ProxyDhcpOptions) {
    super();
  }

  async start() {
    const bind = this.opts.bind ?? "0.0.0.0";
    this.sock67 = await bindUdp(this.opts.port ?? 67, bind, true);
    this.sock4011 = await bindUdp(this.opts.binlPort ?? 4011, bind, false);
    this.sock67.on("message", (m, r) => this.onMessage(m, r, false));
    this.sock4011.on("message", (m, r) => this.onMessage(m, r, true));
  }

  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo, binl: boolean) {
    let req: DhcpPacket;
    try {
      req = parseDhcp(msg);
    } catch {
      return;
    }
    if (req.op !== 1) return;
    const type = req.options.get(Opt.MSG_TYPE)?.[0];
    const info = clientInfo(req);
    if (!info.vendorClass.startsWith("PXEClient") && !info.vendorClass.startsWith("HTTPClient")) return;

    const choice = this.opts.policy(info);
    this.emit("client", { ...info, type, binl, from: rinfo.address, choice });
    if (!choice) return;

    let replyType: number;
    if (!binl && type === MsgType.DISCOVER) replyType = MsgType.OFFER;
    else if (binl && (type === MsgType.REQUEST || type === MsgType.INFORM)) replyType = MsgType.ACK;
    else return; // REQUESTs on :67 belong to the real DHCP server

    const reply = proxyReply(req, replyType, this.opts.serverIp, choice);
    if (binl) {
      // The client has an address by now: answer it directly.
      this.sock4011!.send(reply, rinfo.port, rinfo.address);
    } else {
      this.sock67!.send(reply, 68, "255.255.255.255");
    }
  }

  stop() {
    this.sock67?.close();
    this.sock4011?.close();
    this.sock67 = this.sock4011 = undefined;
  }
}

export function bindUdp(port: number, address: string, broadcast: boolean): Promise<dgram.Socket> {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
    s.once("error", (e: NodeJS.ErrnoException) => {
      s.close();
      if (e.code === "EACCES") {
        reject(
          new Error(
            `Permission denied binding UDP ${port}. Ports below 1024 need privileges on Linux/macOS: ` +
              `run once \`sudo setcap cap_net_bind_service=+ep "$(readlink -f "$(which node)")"\`, or run as root.`,
          ),
        );
      } else if (e.code === "EADDRINUSE") {
        reject(new Error(`UDP ${port} is already in use (another DHCP/TFTP server such as dnsmasq?).`));
      } else reject(e);
    });
    s.bind(port, address, () => {
      if (broadcast) s.setBroadcast(true);
      resolve(s);
    });
  });
}

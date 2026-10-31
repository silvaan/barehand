/**
 * Netboot orchestrator: proxyDHCP + TFTP + HTTP, an iPXE menu generated from
 * the image library, and a request log so the agent can see the target's
 * progress (got iPXE → got the menu → fetching the kernel → fetching rootfs).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AssetCache } from "./assets.js";
import { Arch, ProxyDhcpServer, type BootChoice, type PxeClientInfo } from "./dhcp.js";
import { IsoImage } from "./iso9660.js";
import { detectRecipe, looksLikeUdfOnlyWindows, windowsRecipe, type Recipe } from "./recipes.js";
import { TftpServer } from "./tftp.js";
import { safeFileName } from "../download.js";

const run = promisify(execFile);

/** Where a boot image's files come from: inside an ISO, or an extracted directory. */
interface FileSource {
  stat(p: string): { size: number } | undefined;
  stream(p: string, start: number, end: number): NodeJS.ReadableStream;
}

class IsoSource implements FileSource {
  constructor(private readonly iso: IsoImage) {}
  stat(p: string) {
    const e = this.iso.stat(p);
    return e && !e.isDir ? { size: e.size } : undefined;
  }
  stream(p: string, start: number, end: number) {
    return this.iso.createReadStream(this.iso.stat(p)!, start, end);
  }
}

class DirSource implements FileSource {
  constructor(private readonly dir: string) {}
  private resolve(p: string): string | undefined {
    const full = path.resolve(this.dir, p);
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) return undefined;
    if (fs.existsSync(full)) return full;
    // Case-insensitive fallback (Windows media mixes cases).
    let cur = path.resolve(this.dir);
    for (const part of p.split("/").filter(Boolean)) {
      const hit = fs.existsSync(cur) ? fs.readdirSync(cur).find((n) => n.toLowerCase() === part.toLowerCase()) : undefined;
      if (!hit) return undefined;
      cur = path.join(cur, hit);
    }
    return cur;
  }
  stat(p: string) {
    const f = this.resolve(p);
    if (!f) return undefined;
    const st = fs.statSync(f);
    return st.isFile() ? { size: st.size } : undefined;
  }
  stream(p: string, start: number, end: number) {
    return fs.createReadStream(this.resolve(p)!, { start, end });
  }
}

export interface BootImage {
  id: string;
  isoPath: string;
  label: string;
  recipe?: Recipe;
  source?: FileSource;
  problem?: string;
}

export interface LogEntry {
  t: string;
  kind: "dhcp" | "tftp" | "http";
  client: string;
  what: string;
  ok: boolean;
}

export interface NetbootOptions {
  /** proxy: answer PXE on the LAN (DHCP+TFTP+HTTP). lab: HTTP only; QEMU's own DHCP/TFTP points at our TFTP dir. */
  mode: "proxy" | "lab";
  workDir: string;
  isoPaths: string[];
  serverIp?: string;
  httpPort?: number;
  /** image id, "netbootxyz", "local" or "shell" */
  defaultEntry?: string;
  timeoutS?: number;
  consoleArgs?: string;
  extraArgs?: string;
  tftpPort?: number;
  dhcpPort?: number;
  binlPort?: number;
}

export function guessServerIp(): string | undefined {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) return a.address;
    }
  }
  return undefined;
}

export class NetbootServer {
  readonly images: BootImage[] = [];
  readonly log: LogEntry[] = [];
  readonly assets: AssetCache;
  private httpServer?: http.Server;
  private dhcp?: ProxyDhcpServer;
  private tftp?: TftpServer;
  private openIsos: IsoImage[] = [];
  readonly serverIp: string;
  readonly httpPort: number;
  /** what the target uses to reach us (QEMU user networking maps 10.0.2.2 to the host) */
  readonly advertisedIp: string;
  readonly tftpDir: string;

  constructor(readonly opts: NetbootOptions) {
    this.assets = new AssetCache(path.join(opts.workDir, "netboot", "assets"));
    this.tftpDir = path.join(opts.workDir, "netboot", "tftp");
    this.httpPort = opts.httpPort ?? 8067;
    const ip = opts.serverIp ?? (opts.mode === "lab" ? "127.0.0.1" : guessServerIp());
    if (!ip) throw new Error("Could not find this machine's LAN IPv4 address; pass server_ip.");
    this.serverIp = ip;
    this.advertisedIp = opts.mode === "lab" ? "10.0.2.2" : ip;
  }

  get baseUrl() {
    return `http://${this.advertisedIp}:${this.httpPort}`;
  }

  private record(e: Omit<LogEntry, "t">) {
    this.log.push({ t: new Date().toISOString(), ...e });
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
  }

  async loadImages() {
    const used = new Set<string>();
    for (const isoPath of this.opts.isoPaths) {
      let id = safeFileName(path.basename(isoPath).replace(/\.iso$/i, "").toLowerCase()).slice(0, 40);
      while (used.has(id)) id += "_";
      used.add(id);
      const img: BootImage = { id, isoPath, label: path.basename(isoPath) };
      this.images.push(img);
      try {
        const iso = new IsoImage(isoPath);
        this.openIsos.push(iso);
        const recipe = detectRecipe(iso);
        if (recipe) {
          img.recipe = recipe;
          img.label = recipe.label;
          img.source = new IsoSource(iso);
        } else if (looksLikeUdfOnlyWindows(iso)) {
          img.recipe = windowsRecipe(`Windows Setup / PE (${path.basename(isoPath)})`);
          img.label = img.recipe.label;
          img.source = new DirSource(await this.extractWindows(isoPath, id));
        } else {
          img.problem = "No network-boot recipe for this ISO (unknown distribution). netboot.xyz may still offer it.";
        }
      } catch (e) {
        img.problem = (e as Error).message;
      }
    }
  }

  /** Windows ISOs are UDF-only: extract the three files wimboot needs with 7-Zip. */
  private async extractWindows(isoPath: string, id: string): Promise<string> {
    const out = path.join(this.opts.workDir, "netboot", "extracted", id);
    const marker = path.join(out, ".done");
    if (fs.existsSync(marker)) return out;
    fs.mkdirSync(out, { recursive: true });
    const sevenZip = ["7z", "7zz", "7za"];
    let lastErr: Error | undefined;
    for (const bin of sevenZip) {
      try {
        await run(bin, ["x", "-y", `-o${out}`, isoPath, "boot/bcd", "boot/boot.sdi", "sources/boot.wim", "-r-"], {
          maxBuffer: 16 << 20,
        });
        fs.writeFileSync(marker, "");
        return out;
      } catch (e) {
        lastErr = e as Error;
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") break;
      }
    }
    throw new Error(
      `Windows ISOs are UDF-only and need 7-Zip to extract boot files (install p7zip / 7-Zip). ${lastErr?.message ?? ""}`,
    );
  }

  /** The iPXE menu served at /boot.ipxe. */
  menu(): string {
    const timeoutMs = Math.round((this.opts.timeoutS ?? 5) * 1000);
    const bootable = this.images.filter((i) => i.recipe && i.source);
    const def = this.opts.defaultEntry ?? (bootable[0] ? `img-${bootable[0].id}` : "netbootxyz");
    const defLabel = def.startsWith("img-") || ["netbootxyz", "local", "shell"].includes(def) ? def : `img-${def}`;
    const consoleArgs = this.opts.consoleArgs ?? "console=tty0 console=ttyS0,115200";
    const lines = [
      "#!ipxe",
      `set server ${this.baseUrl}`,
      "menu barehand netboot",
      "item --gap -- Images",
      ...bootable.map((i) => `item img-${i.id} ${i.label}`),
      "item --gap -- Other",
      "item netbootxyz netboot.xyz (needs internet)",
      "item local Boot from local disk",
      "item shell iPXE shell",
      `choose --default ${defLabel} --timeout ${timeoutMs} target && goto \${target} || goto shell`,
      "",
    ];
    for (const i of bootable) {
      const r = i.recipe!;
      const ctx = {
        imgUrl: `${this.baseUrl}/img/${i.id}/`,
        isoUrl: `${this.baseUrl}/iso/${i.id}.iso`,
        consoleArgs,
        extraArgs: this.opts.extraArgs ?? "",
      };
      lines.push(`:img-${i.id}`, `echo barehand: booting ${i.label}`);
      if (r.script) lines.push(...r.script(ctx));
      else {
        const initrdNames = r.initrds.map((p) => `initrd=${path.posix.basename(p)}`).join(" ");
        lines.push(`kernel ${ctx.imgUrl}${r.kernel} ${initrdNames} ${r.cmdline!(ctx)}`.replace(/\s+$/, ""));
        for (const p of r.initrds) lines.push(`initrd ${ctx.imgUrl}${p}`);
        lines.push("boot || goto failed");
      }
      lines.push("");
    }
    lines.push(
      ":netbootxyz",
      "iseq ${platform} efi && chain --autofree ${server}/ipxe/netboot.xyz.efi || chain --autofree ${server}/ipxe/netboot.xyz.lkrn",
      "goto failed",
      "",
      ":local",
      "iseq ${platform} efi && exit 1 || sanboot --no-describe --drive 0x80",
      "",
      ":failed",
      "echo barehand: boot failed, dropping to shell",
      ":shell",
      "shell",
      "",
    );
    return lines.join("\n");
  }

  autoexec(): string {
    return `#!ipxe\ndhcp || echo barehand: dhcp failed\nchain ${this.baseUrl}/boot.ipxe || shell\n`;
  }

  /** proxyDHCP policy: what each PXE client gets. */
  bootChoice(c: PxeClientInfo): BootChoice | undefined {
    if (c.isIpxe) return { file: `${this.baseUrl}/boot.ipxe`, vendorClass: "PXEClient" };
    switch (c.arch) {
      case Arch.EFI_X64_HTTP:
        return { file: `${this.baseUrl}/ipxe/ipxe.efi`, vendorClass: "HTTPClient" };
      case Arch.EFI_BC:
      case Arch.EFI_X64:
        return { file: "ipxe.efi", vendorClass: "PXEClient" };
      case Arch.BIOS:
      case undefined:
        return { file: "undionly.kpxe", vendorClass: "PXEClient" };
      default:
        return undefined; // ARM etc.: not supported yet
    }
  }

  private tftpFile(name: string): Buffer | undefined {
    if (name === "autoexec.ipxe") return Buffer.from(this.autoexec());
    if (name === "boot.ipxe") return Buffer.from(this.menu());
    if (["ipxe.efi", "snponly.efi", "undionly.kpxe"].includes(name)) return this.assets.read(name);
    return undefined;
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const p = decodeURIComponent(url.pathname);
    const client = req.socket.remoteAddress ?? "?";
    const done = (status: number, what = p) => this.record({ kind: "http", client, what: `${status} ${what}`, ok: status < 400 });

    const sendText = (body: string) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body) });
      res.end(req.method === "HEAD" ? undefined : body);
      done(200);
    };
    const sendRange = (size: number, open: (s: number, e: number) => NodeJS.ReadableStream) => {
      let start = 0;
      let end = size - 1;
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
      if (m && (m[1] || m[2])) {
        if (m[1]) {
          start = Number(m[1]);
          if (m[2]) end = Math.min(Number(m[2]), size - 1);
        } else start = Math.max(0, size - Number(m[2]));
        if (start > end || start >= size) {
          res.writeHead(416, { "content-range": `bytes */${size}` });
          res.end();
          return done(416);
        }
        res.writeHead(206, {
          "content-range": `bytes ${start}-${end}/${size}`,
          "content-length": end - start + 1,
          "accept-ranges": "bytes",
          "content-type": "application/octet-stream",
        });
      } else {
        res.writeHead(200, { "content-length": size, "accept-ranges": "bytes", "content-type": "application/octet-stream" });
      }
      if (req.method === "HEAD" || size === 0) {
        res.end();
        return done(200);
      }
      const s = open(start, end);
      s.on("error", () => res.destroy());
      s.pipe(res);
      res.on("finish", () => done(m ? 206 : 200));
    };

    try {
      if (p === "/boot.ipxe") return sendText(this.menu());
      if (p === "/autoexec.ipxe") return sendText(this.autoexec());

      let m = /^\/ipxe\/([\w.-]+)$/.exec(p);
      if (m) {
        const file = await this.assets.ensure(m[1]!);
        const size = fs.statSync(file).size;
        return sendRange(size, (s, e) => fs.createReadStream(file, { start: s, end: e }));
      }
      m = /^\/iso\/([\w.-]+)\.iso$/.exec(p);
      if (m) {
        const img = this.images.find((i) => i.id === m![1]);
        if (img) {
          const size = fs.statSync(img.isoPath).size;
          return sendRange(size, (s, e) => fs.createReadStream(img.isoPath, { start: s, end: e }));
        }
      }
      m = /^\/img\/([\w.-]+)\/(.+)$/.exec(p);
      if (m) {
        const img = this.images.find((i) => i.id === m![1]);
        const st = img?.source?.stat(m[2]!);
        if (img?.source && st) return sendRange(st.size, (s, e) => img.source!.stream(m![2]!, s, e));
      }
      res.writeHead(404).end();
      done(404);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end(String((e as Error).message));
      done(500, `${p} (${(e as Error).message})`);
    }
  }

  async start() {
    await this.loadImages();
    // Fetch iPXE up front: PXE ROMs time out quickly and won't wait for a download.
    const needed = ["ipxe.efi", "undionly.kpxe"];
    const prefetch = [...needed];
    if (this.images.some((i) => i.recipe?.id === "windows-pe")) prefetch.push("wimboot");
    if ((this.opts.defaultEntry ?? "") === "netbootxyz" || !this.images.some((i) => i.recipe)) {
      prefetch.push("netboot.xyz.efi", "netboot.xyz.lkrn");
    }
    await Promise.all(prefetch.map((n) => this.assets.ensure(n)));

    this.httpServer = http.createServer((q, s) => void this.handleHttp(q, s));
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", (e: NodeJS.ErrnoException) =>
        reject(e.code === "EADDRINUSE" ? new Error(`HTTP port ${this.httpPort} is in use; pass http_port.`) : e),
      );
      this.httpServer!.listen(this.httpPort, "0.0.0.0", () => resolve());
    });

    // TFTP root on disk: used by QEMU's built-in TFTP in lab mode, handy for debugging otherwise.
    fs.mkdirSync(this.tftpDir, { recursive: true });
    for (const n of needed) fs.copyFileSync(this.assets.path(n), path.join(this.tftpDir, n));
    fs.writeFileSync(path.join(this.tftpDir, "autoexec.ipxe"), this.autoexec());

    if (this.opts.mode === "proxy") {
      try {
        this.tftp = new TftpServer({ resolve: (n) => this.tftpFile(n), port: this.opts.tftpPort });
        this.tftp.on("transfer", (t) =>
          this.record({ kind: "tftp", client: t.client, what: `${t.file} ${t.ok ? `${t.bytes} bytes` : t.why}`, ok: t.ok }),
        );
        await this.tftp.start();
        this.dhcp = new ProxyDhcpServer({
          serverIp: this.serverIp,
          policy: (c) => this.bootChoice(c),
          port: this.opts.dhcpPort,
          binlPort: this.opts.binlPort,
        });
        this.dhcp.on("client", (c) =>
          this.record({
            kind: "dhcp",
            client: c.mac,
            what: `${c.binl ? "BINL " : ""}type=${c.type} arch=${c.arch ?? "?"}${c.isIpxe ? " iPXE" : ""} → ${c.choice?.file ?? "ignored"}`,
            ok: Boolean(c.choice),
          }),
        );
        await this.dhcp.start();
      } catch (e) {
        await this.stop();
        throw e;
      }
    }
  }

  async stop() {
    this.dhcp?.stop();
    this.tftp?.stop();
    await new Promise<void>((r) => (this.httpServer ? this.httpServer.close(() => r()) : r()));
    this.httpServer = undefined;
    for (const iso of this.openIsos.splice(0)) iso.close();
  }
}

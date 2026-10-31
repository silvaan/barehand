import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Arch, buildDhcp, clientInfo, MsgType, Opt, parseDhcp, proxyReply, type DhcpPacket } from "../src/netboot/dhcp.js";
import { IsoImage } from "../src/netboot/iso9660.js";
import { detectRecipe, looksLikeUdfOnlyWindows } from "../src/netboot/recipes.js";
import { NetbootServer } from "../src/netboot/server.js";
import { TftpServer } from "../src/netboot/tftp.js";
import { writeIso } from "./helpers/iso.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bh-netboot-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const KERNEL = Buffer.alloc(5000, 0x4b); // spans several sectors
const sysrescIso = path.join(tmp, "systemrescue-11.02-amd64.iso");
writeIso(
  sysrescIso,
  {
    sysresccd: {
      boot: {
        "intel_ucode.img": Buffer.from("intel"),
        x86_64: { vmlinuz: KERNEL, "sysresccd.img": Buffer.from("initramfs") },
      },
      x86_64: { "airootfs.sfs": Buffer.alloc(3000, 1) },
    },
  },
  "RESCUE1102",
);

function discover(opts: { arch?: number; ipxe?: boolean; vendor?: string } = {}): DhcpPacket {
  const options = new Map<number, Buffer>();
  options.set(Opt.MSG_TYPE, Buffer.from([MsgType.DISCOVER]));
  options.set(Opt.VENDOR_CLASS, Buffer.from(opts.vendor ?? `PXEClient:Arch:0000${opts.arch ?? 7}:UNDI:003016`));
  const arch = Buffer.alloc(2);
  arch.writeUInt16BE(opts.arch ?? Arch.EFI_BC);
  options.set(Opt.CLIENT_ARCH, arch);
  options.set(Opt.CLIENT_UUID, Buffer.from([0, ...Array(16).fill(7)]));
  if (opts.ipxe) options.set(Opt.USER_CLASS, Buffer.from("iPXE"));
  const chaddr = Buffer.alloc(16);
  Buffer.from([0x52, 0x54, 0, 0x12, 0x34, 0x56]).copy(chaddr);
  return {
    op: 1, htype: 1, hlen: 6, hops: 0, xid: 0xdeadbeef, secs: 0, flags: 0,
    ciaddr: "0.0.0.0", yiaddr: "0.0.0.0", siaddr: "0.0.0.0", giaddr: "0.0.0.0",
    chaddr, sname: "", file: "", options,
  };
}

describe("iso9660", () => {
  it("reads Rock Ridge names, multi-sector files and the volume id", () => {
    const iso = new IsoImage(sysrescIso);
    expect(iso.volumeId).toBe("RESCUE1102");
    expect(iso.list().map((e) => e.name)).toEqual(["sysresccd"]);
    expect(iso.stat("sysresccd/boot/x86_64/vmlinuz")).toMatchObject({ isDir: false, size: 5000 });
    expect(iso.readFile("sysresccd/boot/x86_64/sysresccd.img")?.toString()).toBe("initramfs");
    expect(iso.readFile("sysresccd/boot/x86_64/vmlinuz")?.equals(KERNEL)).toBe(true);
    expect(iso.exists("SYSRESCCD/BOOT/X86_64/VMLINUZ")).toBe(true); // case-insensitive fallback
    expect(iso.exists("nope")).toBe(false);
    iso.close();
  });

  it("rejects non-ISO files", () => {
    const f = path.join(tmp, "not.iso");
    fs.writeFileSync(f, Buffer.alloc(40000));
    expect(() => new IsoImage(f)).toThrow(/not an ISO/);
  });
});

describe("recipes", () => {
  const detect = (tree: Parameters<typeof writeIso>[1]) => {
    const f = path.join(tmp, `r-${Math.random().toString(36).slice(2)}.iso`);
    writeIso(f, tree);
    const iso = new IsoImage(f);
    try {
      return { recipe: detectRecipe(iso), udfWindows: looksLikeUdfOnlyWindows(iso) };
    } finally {
      iso.close();
    }
  };
  const b = Buffer.from("x");

  it("detects distributions from their file layout", () => {
    expect(detect({ casper: { vmlinuz: b, initrd: b } }).recipe?.id).toBe("ubuntu-casper");
    expect(detect({ live: { vmlinuz: b, "initrd.img": b, "filesystem.squashfs": b } }).recipe?.id).toBe("debian-live");
    expect(detect({ images: { pxeboot: { vmlinuz: b, "initrd.img": b }, "install.img": b } }).recipe?.id).toBe("fedora-installer");
    expect(detect({ images: { pxeboot: { vmlinuz: b, "initrd.img": b } }, LiveOS: { "squashfs.img": b } }).recipe?.id).toBe("fedora-live");
    expect(detect({ arch: { boot: { x86_64: { "vmlinuz-linux": b, "initramfs-linux.img": b } } } }).recipe?.id).toBe("archiso");
    expect(detect({ boot: { bcd: b, "boot.sdi": b }, sources: { "boot.wim": b } }).recipe?.id).toBe("windows-pe");
    expect(detect({ "README.TXT": Buffer.from("This disc contains a \"UDF\" file system") }).udfWindows).toBe(true);
    expect(detect({ random: b }).recipe).toBeUndefined();
  });
});

describe("proxyDHCP", () => {
  it("round-trips packets and identifies PXE clients", () => {
    const p = parseDhcp(buildDhcp(discover({ arch: Arch.EFI_X64, ipxe: true })));
    expect(clientInfo(p)).toMatchObject({ mac: "52:54:00:12:34:56", arch: 9, isIpxe: true });
  });

  it("builds a proxy offer with no address and a boot file", () => {
    const req = discover();
    const reply = parseDhcp(proxyReply(req, MsgType.OFFER, "192.168.1.50", { file: "ipxe.efi", vendorClass: "PXEClient" }));
    expect(reply).toMatchObject({ op: 2, xid: 0xdeadbeef, yiaddr: "0.0.0.0", siaddr: "192.168.1.50", file: "ipxe.efi" });
    expect(reply.options.get(Opt.MSG_TYPE)?.[0]).toBe(MsgType.OFFER);
    expect(reply.options.get(Opt.VENDOR_CLASS)?.toString()).toBe("PXEClient");
    expect([...reply.options.get(Opt.VENDOR_SPECIFIC)!]).toEqual([6, 1, 8, 255]);
    expect(reply.options.get(Opt.CLIENT_UUID)?.equals(req.options.get(Opt.CLIENT_UUID)!)).toBe(true);
  });

  it("chooses the right boot file per client", () => {
    const nb = new NetbootServer({ mode: "proxy", workDir: tmp, isoPaths: [], serverIp: "192.168.1.50" });
    const choice = (o: Parameters<typeof discover>[0]) => nb.bootChoice(clientInfo(discover(o)));
    expect(choice({ arch: Arch.BIOS })?.file).toBe("undionly.kpxe");
    expect(choice({ arch: Arch.EFI_X64 })?.file).toBe("ipxe.efi");
    expect(choice({ arch: Arch.EFI_X64, ipxe: true })?.file).toBe("http://192.168.1.50:8067/boot.ipxe");
    expect(choice({ arch: Arch.EFI_X64_HTTP, vendor: "HTTPClient:Arch:00016" })).toEqual({
      file: "http://192.168.1.50:8067/ipxe/ipxe.efi",
      vendorClass: "HTTPClient",
    });
    expect(choice({ arch: 11 })).toBeUndefined(); // ARM64: not yet
  });
});

describe("tftp", () => {
  it("transfers a file with blksize/tsize negotiation", async () => {
    const payload = Buffer.alloc(3000);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const srv = new TftpServer({ resolve: (n) => (n === "ipxe.efi" ? payload : undefined), port: 0, bind: "127.0.0.1" });
    await srv.start();
    const port = srv.port!;

    const got = await new Promise<{ data: Buffer; tsize: string }>((resolve, reject) => {
      const c = dgram.createSocket("udp4");
      const parts: Buffer[] = [];
      let tsize = "";
      c.on("message", (m, r) => {
        const op = m.readUInt16BE(0);
        if (op === 6) {
          const kv = m.subarray(2).toString().split("\0");
          tsize = kv[kv.indexOf("tsize") + 1]!;
          c.send(Buffer.from([0, 4, 0, 0]), r.port, r.address);
        } else if (op === 3) {
          const block = m.readUInt16BE(2);
          parts.push(m.subarray(4));
          c.send(Buffer.from([0, 4, block >> 8, block & 255]), r.port, r.address);
          if (m.length - 4 < 1024) {
            c.close();
            resolve({ data: Buffer.concat(parts), tsize });
          }
        } else reject(new Error(`unexpected op ${op}`));
      });
      c.send(Buffer.from("\0\x01ipxe.efi\0octet\0blksize\x001024\0tsize\x000\0", "latin1"), port, "127.0.0.1");
    });
    srv.stop();
    expect(got.tsize).toBe("3000");
    expect(got.data.equals(payload)).toBe(true);
  });
});

describe("NetbootServer (lab mode)", () => {
  it("serves the menu, autoexec and files from inside the ISO, with ranges", async () => {
    const workDir = path.join(tmp, "wd");
    // Seed the asset cache so the test never touches the network.
    const assets = path.join(workDir, "netboot", "assets");
    fs.mkdirSync(assets, { recursive: true });
    for (const n of ["ipxe.efi", "undionly.kpxe"]) fs.writeFileSync(path.join(assets, n), `fake ${n}`);

    const nb = new NetbootServer({
      mode: "lab",
      workDir,
      isoPaths: [sysrescIso],
      httpPort: 0 + 18000 + Math.floor(Math.random() * 1000),
      consoleArgs: "console=ttyS0,115200",
    });
    await nb.start();
    try {
      const base = `http://127.0.0.1:${nb.httpPort}`;
      const menu = await (await fetch(`${base}/boot.ipxe`)).text();
      expect(menu).toContain("#!ipxe");
      expect(menu).toContain("item img-systemrescue-11.02-amd64 SystemRescue (RESCUE1102)");
      expect(menu).toContain("choose --default img-systemrescue-11.02-amd64");
      expect(menu).toContain(
        "kernel http://10.0.2.2:" + nb.httpPort + "/img/systemrescue-11.02-amd64/sysresccd/boot/x86_64/vmlinuz " +
          "initrd=intel_ucode.img initrd=sysresccd.img archisobasedir=sysresccd " +
          "archiso_http_srv=http://10.0.2.2:" + nb.httpPort + "/img/systemrescue-11.02-amd64/ ip=dhcp setkmap=us console=ttyS0,115200",
      );
      expect(fs.readFileSync(path.join(nb.tftpDir, "autoexec.ipxe"), "utf8")).toContain(`chain http://10.0.2.2:${nb.httpPort}/boot.ipxe`);

      const k = await fetch(`${base}/img/systemrescue-11.02-amd64/sysresccd/boot/x86_64/vmlinuz`);
      expect(Buffer.from(await k.arrayBuffer()).equals(KERNEL)).toBe(true);

      const r = await fetch(`${base}/img/systemrescue-11.02-amd64/sysresccd/boot/x86_64/vmlinuz`, { headers: { range: "bytes=4990-" } });
      expect(r.status).toBe(206);
      expect(r.headers.get("content-range")).toBe("bytes 4990-4999/5000");
      expect((await r.arrayBuffer()).byteLength).toBe(10);

      expect((await fetch(`${base}/img/systemrescue-11.02-amd64/../../etc/passwd`)).status).toBe(404);
      expect((await fetch(`${base}/iso/systemrescue-11.02-amd64.iso`, { method: "HEAD" })).headers.get("content-length")).toBe(
        String(fs.statSync(sysrescIso).size),
      );
      expect(nb.log.some((e) => e.what.includes("vmlinuz") && e.ok)).toBe(true);
    } finally {
      await nb.stop();
    }
  });
});

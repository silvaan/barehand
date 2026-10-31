/**
 * Boot binaries fetched from their official sources on first use and cached.
 * netboot.xyz publishes SHA-256 sums; iPXE and wimboot are fetched over HTTPS
 * from boot.ipxe.org / GitHub releases (no published sums for rolling builds).
 */
import fs from "node:fs";
import path from "node:path";
import { download } from "../download.js";

export interface Asset {
  name: string;
  url: string;
  sha256SumsUrl?: string;
  why: string;
}

const NBXYZ_SUMS = "https://boot.netboot.xyz/ipxe/netboot.xyz-sha256-checksums.txt";

export const ASSETS: Record<string, Asset> = {
  "ipxe.efi": { name: "ipxe.efi", url: "https://boot.ipxe.org/x86_64-efi/ipxe.efi", why: "iPXE for UEFI x86-64 PXE clients" },
  "snponly.efi": { name: "snponly.efi", url: "https://boot.ipxe.org/x86_64-efi/snponly.efi", why: "iPXE using the firmware's network driver (fallback for unsupported NICs)" },
  "undionly.kpxe": { name: "undionly.kpxe", url: "https://boot.ipxe.org/undionly.kpxe", why: "iPXE for legacy BIOS PXE clients" },
  "netboot.xyz.efi": { name: "netboot.xyz.efi", url: "https://boot.netboot.xyz/ipxe/netboot.xyz.efi", sha256SumsUrl: NBXYZ_SUMS, why: "netboot.xyz menu (UEFI)" },
  "netboot.xyz.lkrn": { name: "netboot.xyz.lkrn", url: "https://boot.netboot.xyz/ipxe/netboot.xyz.lkrn", sha256SumsUrl: NBXYZ_SUMS, why: "netboot.xyz menu (BIOS, chainloaded from iPXE)" },
  wimboot: { name: "wimboot", url: "https://github.com/ipxe/wimboot/releases/latest/download/wimboot", why: "boots Windows PE/Setup from boot.wim" },
};

export class AssetCache {
  private inflight = new Map<string, Promise<string>>();

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  path(name: string): string {
    return path.join(this.dir, name);
  }

  has(name: string): boolean {
    return fs.existsSync(this.path(name));
  }

  /** Ensure an asset is present locally; returns its path. */
  async ensure(name: string): Promise<string> {
    const a = ASSETS[name];
    if (!a) throw new Error(`Unknown boot asset ${name}`);
    if (this.has(name)) return this.path(name);
    let p = this.inflight.get(name);
    if (!p) {
      p = download(a.url, this.dir, { fileName: a.name, sha256SumsUrl: a.sha256SumsUrl }).then((r) => r.path);
      this.inflight.set(name, p);
      p.finally(() => this.inflight.delete(name)).catch(() => {});
    }
    return p;
  }

  read(name: string): Buffer | undefined {
    return this.has(name) ? fs.readFileSync(this.path(name)) : undefined;
  }
}

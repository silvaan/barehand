/**
 * Minimal read-only ISO 9660 reader with Rock Ridge names.
 *
 * Purpose: serve a kernel, initrd or squashfs straight out of an ISO over
 * HTTP (byte ranges of the image file), with no extraction and no external
 * tools. Windows install ISOs are UDF-only (their ISO 9660 tree holds just a
 * README) and are handled separately (see recipes.ts).
 */
import fs from "node:fs";

const SECTOR = 2048;

export interface IsoEntry {
  name: string;
  isDir: boolean;
  /** byte offset of the file data inside the image */
  offset: number;
  size: number;
}

function readAt(fd: number, offset: number, length: number): Buffer {
  const b = Buffer.alloc(length);
  const n = fs.readSync(fd, b, 0, length, offset);
  return n === length ? b : b.subarray(0, n);
}

/** Parse the Rock Ridge alternate name (NM) from a System Use area, if any. */
function rockRidgeName(su: Buffer): string | undefined {
  let i = 0;
  let name = "";
  let found = false;
  while (i + 4 <= su.length) {
    const sig = su.toString("latin1", i, i + 2);
    const len = su[i + 2]!;
    if (len < 4 || i + len > su.length) break;
    if (sig === "NM") {
      const flags = su[i + 4]!;
      if (!(flags & 0x06)) {
        // bit1 = ".", bit2 = ".."
        name += su.toString("utf8", i + 5, i + len);
        found = true;
      }
      if (!(flags & 0x01)) break; // no continuation
    }
    i += len;
  }
  return found ? name : undefined;
}

function primaryName(raw: Buffer): string {
  let n = raw.toString("latin1");
  n = n.replace(/;\d+$/, "");
  if (n.endsWith(".")) n = n.slice(0, -1);
  return n;
}

export class IsoImage {
  private fd: number;
  private root: IsoEntry;
  /** bytes to skip at the start of each System Use area (SUSP "SP" entry) */
  private suspSkip = 0;
  readonly volumeId: string;
  private dirCache = new Map<number, IsoEntry[]>();

  constructor(readonly path: string) {
    this.fd = fs.openSync(path, "r");
    let pvd: Buffer | undefined;
    for (let s = 16; s < 64; s++) {
      const vd = readAt(this.fd, s * SECTOR, SECTOR);
      if (vd.length < SECTOR || vd.toString("latin1", 1, 6) !== "CD001") break;
      if (vd[0] === 1) {
        pvd = vd;
        break;
      }
      if (vd[0] === 255) break;
    }
    if (!pvd) {
      fs.closeSync(this.fd);
      throw new Error(`${path}: not an ISO 9660 image (no primary volume descriptor)`);
    }
    if (pvd.readUInt16LE(128) !== SECTOR) throw new Error(`${path}: unsupported logical block size`);
    this.volumeId = pvd.toString("latin1", 40, 72).trim();
    const rec = pvd.subarray(156, 156 + 34);
    this.root = { name: "", isDir: true, offset: rec.readUInt32LE(2) * SECTOR, size: rec.readUInt32LE(10) };

    // SUSP "SP" in the root's "." record tells us the skip length and that SUSP is in use.
    const dot = readAt(this.fd, this.root.offset, 255);
    const nameLen = dot[32]!;
    let suStart = 33 + nameLen + (nameLen % 2 === 0 ? 1 : 0);
    const su = dot.subarray(suStart, dot[0]!);
    if (su.toString("latin1", 0, 2) === "SP" && su[4] === 0xbe && su[5] === 0xef) this.suspSkip = su[6]!;
  }

  close() {
    fs.closeSync(this.fd);
  }

  list(dir: IsoEntry = this.root): IsoEntry[] {
    const cached = this.dirCache.get(dir.offset);
    if (cached) return cached;
    const data = readAt(this.fd, dir.offset, dir.size);
    const out: IsoEntry[] = [];
    let i = 0;
    while (i < data.length) {
      const len = data[i]!;
      if (len === 0) {
        i = (Math.floor(i / SECTOR) + 1) * SECTOR; // records never span sectors
        continue;
      }
      const rec = data.subarray(i, i + len);
      const nameLen = rec[32]!;
      const rawName = rec.subarray(33, 33 + nameLen);
      i += len;
      if (nameLen === 1 && (rawName[0] === 0 || rawName[0] === 1)) continue; // "." and ".."
      const suStart = 33 + nameLen + (nameLen % 2 === 0 ? 1 : 0) + this.suspSkip;
      const rr = suStart < rec.length ? rockRidgeName(rec.subarray(suStart)) : undefined;
      const flags = rec[25]!;
      const entry: IsoEntry = {
        name: rr ?? primaryName(rawName),
        isDir: Boolean(flags & 0x02),
        offset: rec.readUInt32LE(2) * SECTOR,
        size: rec.readUInt32LE(10),
      };
      // Multi-extent files (>4 GiB): later extents follow with the same name.
      const prev = out[out.length - 1];
      if (prev && prev.name === entry.name && !entry.isDir && prev.offset + prev.size <= entry.offset) {
        prev.size += entry.size;
        continue;
      }
      out.push(entry);
    }
    this.dirCache.set(dir.offset, out);
    return out;
  }

  /** Look up a path such as "casper/vmlinuz". Exact name first, then case-insensitive. */
  stat(path: string): IsoEntry | undefined {
    let cur: IsoEntry = this.root;
    for (const part of path.split("/").filter(Boolean)) {
      if (!cur.isDir) return undefined;
      const items = this.list(cur);
      const next = items.find((e) => e.name === part) ?? items.find((e) => e.name.toLowerCase() === part.toLowerCase());
      if (!next) return undefined;
      cur = next;
    }
    return cur;
  }

  exists(path: string): boolean {
    return this.stat(path) !== undefined;
  }

  readFile(path: string, maxBytes = 1 << 20): Buffer | undefined {
    const e = this.stat(path);
    if (!e || e.isDir) return undefined;
    return readAt(this.fd, e.offset, Math.min(e.size, maxBytes));
  }

  /** Stream a byte range of a file (for HTTP responses). */
  createReadStream(e: IsoEntry, start = 0, end = e.size - 1): fs.ReadStream {
    return fs.createReadStream(this.path, { start: e.offset + start, end: e.offset + end });
  }
}

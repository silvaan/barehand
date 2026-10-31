/**
 * Tiny ISO 9660 + Rock Ridge (NM) writer, just enough to test the reader and
 * recipe detection without shipping real distribution ISOs.
 */
import fs from "node:fs";

const S = 2048;
export type Tree = { [name: string]: Tree | Buffer };

interface Node {
  name: string;
  dir: boolean;
  lba: number;
  size: number;
  data?: Buffer;
  children: Node[];
  parent?: Node;
}

function primary(name: string, dir: boolean): string {
  const up = name.toUpperCase().replace(/[^A-Z0-9_.]/g, "_");
  if (dir) return up.replace(/\./g, "_").slice(0, 31);
  const [base, ...ext] = up.split(".");
  return `${(base || "_").slice(0, 8)}.${ext.join("_").slice(0, 3)};1`;
}

function record(name: Buffer, lba: number, size: number, dir: boolean, su: Buffer): Buffer {
  const pad = name.length % 2 === 0 ? 1 : 0;
  const len = 33 + name.length + pad + su.length;
  const r = Buffer.alloc(len + (len % 2));
  r[0] = r.length;
  r.writeUInt32LE(lba, 2);
  r.writeUInt32BE(lba, 6);
  r.writeUInt32LE(size, 10);
  r.writeUInt32BE(size, 14);
  r[25] = dir ? 2 : 0;
  r.writeUInt16LE(1, 28);
  r.writeUInt16BE(1, 30);
  r[32] = name.length;
  name.copy(r, 33);
  su.copy(r, 33 + name.length + pad);
  return r;
}

const nm = (name: string) => {
  const n = Buffer.from(name);
  return Buffer.concat([Buffer.from([0x4e, 0x4d, 5 + n.length, 1, 0]), n]);
};
const sp = Buffer.from([0x53, 0x50, 7, 1, 0xbe, 0xef, 0]);

export function buildIso(tree: Tree, volumeId = "TEST_ISO"): Buffer {
  const build = (name: string, t: Tree, parent?: Node): Node => {
    const node: Node = { name, dir: true, lba: 0, size: S, children: [], parent };
    for (const [k, v] of Object.entries(t)) {
      node.children.push(
        Buffer.isBuffer(v) ? { name: k, dir: false, lba: 0, size: v.length, data: v, children: [], parent: node } : build(k, v, node),
      );
    }
    return node;
  };
  const root = build("", tree);
  let next = 18;
  const all: Node[] = [];
  const walk = (n: Node) => {
    all.push(n);
    n.children.forEach(walk);
  };
  walk(root);
  for (const n of all.filter((n) => n.dir)) n.lba = next++;
  for (const n of all.filter((n) => !n.dir)) {
    n.lba = next;
    next += Math.max(1, Math.ceil(n.size / S));
  }
  const img = Buffer.alloc(next * S);

  // Primary volume descriptor + terminator
  const pvd = img.subarray(16 * S, 17 * S);
  pvd[0] = 1;
  pvd.write("CD001", 1, "latin1");
  pvd[6] = 1;
  pvd.write(volumeId.padEnd(32), 40, "latin1");
  pvd.writeUInt16LE(S, 128);
  pvd.writeUInt16BE(S, 130);
  record(Buffer.from([0]), root.lba, S, true, Buffer.alloc(0)).copy(pvd, 156);
  const term = img.subarray(17 * S, 18 * S);
  term[0] = 255;
  term.write("CD001", 1, "latin1");

  for (const n of all) {
    if (n.dir) {
      const recs = [
        record(Buffer.from([0]), n.lba, S, true, n === root ? sp : Buffer.alloc(0)),
        record(Buffer.from([1]), (n.parent ?? n).lba, S, true, Buffer.alloc(0)),
        ...n.children.map((c) => record(Buffer.from(primary(c.name, c.dir)), c.lba, c.size, c.dir, nm(c.name))),
      ];
      Buffer.concat(recs).copy(img, n.lba * S);
    } else {
      n.data!.copy(img, n.lba * S);
    }
  }
  return img;
}

export function writeIso(file: string, tree: Tree, volumeId?: string) {
  fs.writeFileSync(file, buildIso(tree, volumeId));
}

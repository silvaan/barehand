#!/usr/bin/env node
// Record a lab VM's screen through its VNC server, without touching QMP (which the agent is using).
//   node lab/record-vnc.mjs <host:port> <out-dir> [fps=2]
// Writes <out-dir>/<epoch-ms>.png whenever the screen changed (and at least every 5 s). Reconnects if the VM restarts.
// Minimal RFB 3.8 client: no auth, raw encoding, DesktopSize.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PNG } from "pngjs";

const [target, outDir, fpsArg] = process.argv.slice(2);
if (!target || !outDir) {
  console.error("usage: record-vnc.mjs <host:port> <out-dir> [fps]");
  process.exit(2);
}
const [host, port] = target.includes(":") ? target.split(":") : ["127.0.0.1", target];
const fps = Number(fpsArg ?? 2);
fs.mkdirSync(outDir, { recursive: true });

function session() {
  return new Promise((resolve) => {
    const sock = net.connect(Number(port), host);
    let buf = Buffer.alloc(0);
    let waiter = null;
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (waiter && buf.length >= waiter.n) {
        const w = waiter;
        waiter = null;
        w.resolve();
      }
    });
    const closed = new Promise((r) => sock.on("close", r));
    sock.on("error", () => {});
    const read = async (n) => {
      if (buf.length < n) {
        await Promise.race([new Promise((r) => (waiter = { n, resolve: r })), closed.then(() => { throw new Error("closed"); })]);
      }
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    };

    (async () => {
      await read(12); // "RFB 003.008\n"
      sock.write("RFB 003.008\n");
      const nTypes = (await read(1))[0];
      const types = [...(await read(nTypes))];
      if (!types.includes(1)) throw new Error(`VNC needs auth (types ${types})`);
      sock.write(Buffer.from([1]));
      if ((await read(4)).readUInt32BE(0) !== 0) throw new Error("VNC security failed");
      sock.write(Buffer.from([1])); // shared
      const init = await read(24);
      let w = init.readUInt16BE(0);
      let h = init.readUInt16BE(2);
      await read(init.readUInt32BE(20)); // desktop name
      // 32bpp little-endian BGRX
      const pf = Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
      sock.write(pf);
      const enc = Buffer.alloc(12);
      enc.writeUInt8(2, 0);
      enc.writeUInt16BE(2, 2);
      enc.writeInt32BE(0, 4); // raw
      enc.writeInt32BE(-223, 8); // DesktopSize
      sock.write(enc);
      let fb = Buffer.alloc(w * h * 4);
      const request = (incremental) => {
        const m = Buffer.alloc(10);
        m.writeUInt8(3, 0);
        m.writeUInt8(incremental ? 1 : 0, 1);
        m.writeUInt16BE(w, 6);
        m.writeUInt16BE(h, 8);
        sock.write(m);
      };
      let dirty = true;
      let lastSave = 0;
      const save = () => {
        const png = new PNG({ width: w, height: h });
        for (let i = 0, j = 0; i < w * h; i++, j += 4) {
          png.data[j] = fb[j + 2];
          png.data[j + 1] = fb[j + 1];
          png.data[j + 2] = fb[j];
          png.data[j + 3] = 255;
        }
        fs.writeFileSync(path.join(outDir, `${Date.now()}.png`), PNG.sync.write(png));
        lastSave = Date.now();
        dirty = false;
      };
      const timer = setInterval(() => {
        if (dirty || Date.now() - lastSave > 5000) save();
        request(true);
      }, 1000 / fps);
      closed.then(() => clearInterval(timer));
      request(false);
      for (;;) {
        const type = (await read(1))[0];
        if (type === 0) {
          const n = (await read(3)).readUInt16BE(1);
          for (let r = 0; r < n; r++) {
            const hd = await read(12);
            const x = hd.readUInt16BE(0), y = hd.readUInt16BE(2), rw = hd.readUInt16BE(4), rh = hd.readUInt16BE(6);
            const e = hd.readInt32BE(8);
            if (e === -223) {
              w = rw;
              h = rh;
              fb = Buffer.alloc(w * h * 4);
              request(false);
            } else if (e === 0) {
              const px = await read(rw * rh * 4);
              for (let row = 0; row < rh; row++) {
                px.copy(fb, ((y + row) * w + x) * 4, row * rw * 4, (row + 1) * rw * 4);
              }
            } else throw new Error(`unexpected encoding ${e}`);
          }
          dirty = true;
        } else if (type === 1) {
          const hd = await read(5);
          await read(hd.readUInt16BE(3) * 6);
        } else if (type === 2) {
          // bell
        } else if (type === 3) {
          const len = (await read(7)).readUInt32BE(3);
          await read(len);
        } else throw new Error(`unexpected message ${type}`);
      }
    })()
      .catch((e) => {
        if (e.message !== "closed") console.error("vnc:", e.message);
      })
      .finally(() => {
        sock.destroy();
        resolve();
      });
  });
}

process.on("SIGTERM", () => process.exit(0));
for (;;) {
  await session();
  await new Promise((r) => setTimeout(r, 1000));
}

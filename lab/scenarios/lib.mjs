// Shared plumbing for lab scenarios: slots (isolated VM + MCP server), the MCP client, and process helpers.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CACHE = process.env.BAREHAND_LAB_CACHE ?? path.join(os.homedir(), ".cache", "barehand");
export const IMAGES = path.join(CACHE, "lab-images"); // base + scenario disks
export const ISO_DIR = path.join(CACHE, "images"); // ISOs shared by every slot
export const ASSETS = path.join(CACHE, "netboot", "assets"); // iPXE etc., shared by every slot
export const RESCUE_ISO = "systemrescue-13.02-amd64.iso";
export const RESCUE_ISO_URL = "https://fastly-cdn.system-rescue.org/releases/13.02/systemrescue-13.02-amd64.iso";
export const DEBIAN_URL = "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2";
export const DEBIAN_SUMS = "https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/** A slot is one isolated lab target: its own workdir, sockets, netboot port, VNC display and driver port. */
export function slot(n) {
  const dir = path.join(CACHE, "eval", `slot${n}`);
  return {
    n,
    dir,
    port: 8070 + n, // netboot HTTP
    vnc: `:${10 + n}`,
    driverPort: 7810 + n,
    disk: path.join(dir, "disk.qcow2"),
    env: { ...process.env, BAREHAND_BACKEND: "qemu", BAREHAND_WORKDIR: dir, BAREHAND_NETBOOT_PORT: String(8070 + n) },
  };
}

export function prepareSlotDir(s) {
  fs.mkdirSync(path.join(s.dir, "netboot"), { recursive: true });
  const link = (target, at) => {
    try {
      fs.lstatSync(at);
    } catch {
      fs.mkdirSync(target, { recursive: true });
      fs.symlinkSync(target, at);
    }
  };
  link(ISO_DIR, path.join(s.dir, "images"));
  link(ASSETS, path.join(s.dir, "netboot", "assets"));
}

function pidFile(s, what) {
  return path.join(s.dir, `${what}.pid`);
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopProc(s, what) {
  const f = pidFile(s, what);
  if (!fs.existsSync(f)) return;
  const pid = Number(fs.readFileSync(f, "utf8"));
  if (pid && isAlive(pid)) {
    try {
      process.kill(-pid, "SIGTERM"); // process group: run-target.sh execs qemu; the driver owns `barehand serve`
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    for (let i = 0; i < 100 && isAlive(pid); i++) await sleep(100);
    if (isAlive(pid)) process.kill(-pid, "SIGKILL");
  }
  fs.rmSync(f, { force: true });
}

/** Start a detached process in its own group, output to <slot>/<what>.log, pid in <slot>/<what>.pid. */
export function startProc(s, what, cmd, args, env = s.env) {
  const out = fs.openSync(path.join(s.dir, `${what}.log`), "w");
  const child = spawn(cmd, args, { env, detached: true, stdio: ["ignore", out, out], cwd: REPO });
  child.unref();
  fs.writeFileSync(pidFile(s, what), String(child.pid));
  return child.pid;
}

export async function startVm(s, { disk, netboot = "fallback", mem = "3G", fresh = true } = {}) {
  await stopProc(s, "vm");
  const args = ["--disk", disk, "--mem", mem, "--vnc", s.vnc];
  if (netboot === "first") args.push("--netboot");
  if (netboot === "fallback") args.push("--netboot-fallback");
  if (fresh) args.push("--fresh");
  const qmp = path.join(s.dir, "lab", "qmp.sock");
  fs.rmSync(qmp, { force: true });
  startProc(s, "vm", path.join(REPO, "lab", "run-target.sh"), args);
  for (let i = 0; i < 300; i++) {
    if (fs.existsSync(qmp)) return;
    await sleep(100);
  }
  throw new Error(`VM in slot ${s.n} did not start; see ${path.join(s.dir, "vm.log")}`);
}

/** MCP client talking to `barehand serve` for this slot. */
export async function mcp(s) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO, "dist", "cli.js"), "serve"],
    env: s.env,
    stderr: "ignore",
  });
  const client = new Client({ name: "barehand-lab-scenarios", version: "0" });
  await client.connect(transport);
  const call = async (name, args = {}, timeoutMs = 600_000) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    const text = (r.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const images = (r.content ?? []).filter((c) => c.type === "image").map((c) => Buffer.from(c.data, "base64"));
    if (r.isError) throw new Error(`${name}: ${text}`);
    return { text, images };
  };
  return { client, call, close: () => client.close() };
}

/** Find the JSON block a tool appends after its text output. */
export function lastJson(text) {
  const i = text.lastIndexOf("\n{");
  try {
    return JSON.parse(i >= 0 ? text.slice(i + 1) : text);
  } catch {
    return undefined;
  }
}

export function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(" ")}: ${err || out}`))));
  });
}

export const overlay = (backing, file, size) =>
  sh("qemu-img", ["create", "-q", "-f", "qcow2", "-b", backing, "-F", "qcow2", file, ...(size ? [size] : [])]);

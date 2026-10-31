#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { SerialPort } from "serialport";
import { loadConfig, configPaths } from "./config.js";
import { Session } from "./session.js";
import { serveStdio } from "./server.js";
import { VERSION } from "./version.js";

const HELP = `barehand ${VERSION}: an out-of-band PC technician for AI agents

Usage:
  barehand serve        Run the MCP server on stdio (default)
  barehand doctor       Check prerequisites and try the configured backend
  barehand ports        List serial ports (find the ESP32)
  barehand --version

Config: ${configPaths().join(" → ")}
Env:    BAREHAND_BACKEND=qemu|diy, BAREHAND_QMP, BAREHAND_QEMU_SERIAL,
        BAREHAND_DIY_PORT, BAREHAND_VIDEO_DEVICE, BAREHAND_LAYOUT, BAREHAND_WORKDIR`;

function which(bin: string, args = ["-version"]): string | undefined {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 5000 });
  if (r.error) return undefined;
  // Some tools (pdftotext) print their version on stderr.
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n")[0] || bin;
}

async function doctor(): Promise<number> {
  let problems = 0;
  const line = (ok: boolean | "warn", label: string, detail = "") => {
    const icon = ok === true ? "✔" : ok === "warn" ? "!" : "✘";
    if (ok === false) problems++;
    console.log(`${icon} ${label}${detail ? `: ${detail}` : ""}`);
  };

  const major = Number(process.versions.node.split(".")[0]);
  line(major >= 20, "node", process.versions.node);

  let loaded;
  try {
    loaded = loadConfig();
    line(true, "config", loaded.source ?? "defaults (no config file)");
  } catch (e) {
    line(false, "config", (e as Error).message);
    return 1;
  }
  const { config } = loaded;
  line(true, "backend", config.backend);

  const ffmpeg = which("ffmpeg");
  line(config.backend === "diy" ? Boolean(ffmpeg) : ffmpeg ? true : "warn", "ffmpeg", ffmpeg ?? "not found (needed for capture cards)");
  const pdf = which("pdftotext", ["-v"]);
  line(pdf ? true : "warn", "pdftotext", pdf ?? "not found (needed to index PDF manuals: poppler-utils)");
  if (config.backend === "qemu") {
    const q = which("qemu-system-x86_64", ["--version"]);
    line(q ? true : "warn", "qemu-system-x86_64", q ?? "not found (only needed on the machine running the lab VM)");
  }

  const session = new Session(config);
  try {
    const b = await session.get();
    line(true, "connect", `${b.name} ${JSON.stringify(b.capabilities)}`);
    const f = await session.capture();
    line(true, "capture", `${f.width}x${f.height}, ${(f.png.length / 1024).toFixed(0)} KiB`);
    if (b.powerState && b.capabilities.powerSense) line(true, "power", await b.powerState());
  } catch (e) {
    line(false, "connect", (e as Error).message);
    if (config.backend === "qemu") console.log("  → start the lab VM first: lab/run-target.sh");
    else console.log("  → check wiring and `barehand ports`; see docs/hardware.md");
  } finally {
    await session.close().catch(() => {});
  }
  return problems ? 1 : 0;
}

async function ports() {
  const list = await SerialPort.list();
  if (!list.length) console.log("No serial ports found.");
  for (const p of list) {
    console.log(`${p.path}\t${p.manufacturer ?? ""}\t${p.vendorId ?? ""}:${p.productId ?? ""}\t${p.serialNumber ?? ""}`);
  }
}

async function main() {
  const cmd = process.argv[2] ?? "serve";
  switch (cmd) {
    case "serve":
      await serveStdio();
      break;
    case "doctor":
      process.exit(await doctor());
    case "ports":
      await ports();
      break;
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    case "--help":
    case "-h":
    case "help":
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command "${cmd}"\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

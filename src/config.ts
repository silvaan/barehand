/**
 * Configuration: barehand.config.json (cwd, then ~/.config/barehand/config.json),
 * overridden by environment variables.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const ConfigSchema = z.object({
  backend: z.enum(["qemu", "diy"]).default("qemu"),
  /** Target keyboard layout once an OS is running. BIOS/GRUB are always "us". */
  layout: z.enum(["us", "abnt2"]).default("us"),
  workDir: z.string().default(path.join(os.homedir(), ".cache", "barehand")),
  /** Socket paths default to <workDir>/lab/, where lab/run-target.sh creates them. */
  qemu: z
    .object({
      qmp: z.string().optional(),
      serial: z.string().optional(),
      cdromId: z.string().default("cd0"),
    })
    .default({ cdromId: "cd0" }),
  diy: z
    .object({
      serialPort: z.string().default(process.platform === "win32" ? "COM3" : "/dev/ttyUSB0"),
      baud: z.number().default(921600),
      power: z.boolean().default(true),
      video: z
        .object({
          device: z.string().default(process.platform === "win32" ? "USB Video" : "/dev/video0"),
          size: z.string().optional(),
          fps: z.number().default(4),
          maxWidth: z.number().default(1280),
        })
        .default({ device: process.platform === "win32" ? "USB Video" : "/dev/video0", fps: 4, maxWidth: 1280 }),
    })
    .optional(),
});

type Parsed = z.infer<typeof ConfigSchema>;
export type Config = Omit<Parsed, "qemu"> & { qemu: { qmp: string; serial: string; cdromId: string } };

function readJson(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Invalid config file ${file}: ${(e as Error).message}`);
  }
}

export function configPaths(): string[] {
  return [
    process.env.BAREHAND_CONFIG,
    path.resolve("barehand.config.json"),
    path.join(os.homedir(), ".config", "barehand", "config.json"),
  ].filter((p): p is string => Boolean(p));
}

export function loadConfig(): { config: Config; source?: string } {
  let raw: Record<string, any> = {};
  let source: string | undefined;
  for (const p of configPaths()) {
    const j = readJson(p);
    if (j !== undefined) {
      raw = j as Record<string, any>;
      source = p;
      break;
    }
  }
  const env = process.env;
  if (env.BAREHAND_BACKEND) raw.backend = env.BAREHAND_BACKEND;
  if (env.BAREHAND_LAYOUT) raw.layout = env.BAREHAND_LAYOUT;
  if (env.BAREHAND_WORKDIR) raw.workDir = env.BAREHAND_WORKDIR;
  if (env.BAREHAND_QMP || env.BAREHAND_QEMU_SERIAL) {
    raw.qemu = { ...raw.qemu };
    if (env.BAREHAND_QMP) raw.qemu.qmp = env.BAREHAND_QMP;
    if (env.BAREHAND_QEMU_SERIAL) raw.qemu.serial = env.BAREHAND_QEMU_SERIAL;
  }
  if (env.BAREHAND_DIY_PORT || env.BAREHAND_VIDEO_DEVICE) {
    raw.diy = { ...raw.diy };
    if (env.BAREHAND_DIY_PORT) raw.diy.serialPort = env.BAREHAND_DIY_PORT;
    if (env.BAREHAND_VIDEO_DEVICE) raw.diy.video = { ...raw.diy.video, device: env.BAREHAND_VIDEO_DEVICE };
  }
  if (raw.backend === "diy" && !raw.diy) raw.diy = {};
  const parsed = ConfigSchema.parse(raw);
  const labDir = path.join(parsed.workDir, "lab");
  const config = {
    ...parsed,
    qemu: {
      ...parsed.qemu,
      qmp: parsed.qemu.qmp ?? path.join(labDir, "qmp.sock"),
      serial: parsed.qemu.serial ?? path.join(labDir, "serial.sock"),
    },
  };
  return { config, source };
}

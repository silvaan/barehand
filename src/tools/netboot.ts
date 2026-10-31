import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { IsoImage } from "../netboot/iso9660.js";
import { detectRecipe, looksLikeUdfOnlyWindows } from "../netboot/recipes.js";
import { NetbootServer } from "../netboot/server.js";
import { guarded, json, text, type Ctx } from "./common.js";

/** Kernel args that give us a shell on the backend's console device. */
function consoleArgsFor(backend: string): string {
  // QEMU: ttyS0 is a real serial console. DIY: the ESP32's CDC port shows up as ttyACM0, which
  // can't be a kernel console, so ask systemd for a getty on it instead.
  return backend === "diy"
    ? "console=tty0 systemd.wants=serial-getty@ttyACM0.service"
    : "console=tty0 console=ttyS0,115200";
}

export function registerNetbootTools({ server, config }: Ctx) {
  let nb: NetbootServer | undefined;
  const imagesDir = path.join(config.workDir, "images");

  const resolveIso = (p: string) => {
    const candidates = [p, path.join(imagesDir, p), path.join(imagesDir, `${p}.iso`)];
    const hit = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!hit) throw new Error(`ISO not found: ${p} (looked in ${imagesDir})`);
    return path.resolve(hit);
  };

  server.registerTool(
    "iso_list",
    {
      title: "List local OS images and how they boot",
      description:
        "List ISOs in the image library (downloads from iso_download land here) and, for each, whether barehand " +
        "knows how to network-boot it (detected distribution / recipe).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      guarded(async () => {
        if (!fs.existsSync(imagesDir)) return [text(`No images yet (${imagesDir}). Use iso_download.`)];
        const rows = fs
          .readdirSync(imagesDir)
          .filter((f) => /\.(iso|img)$/i.test(f))
          .map((f) => {
            const full = path.join(imagesDir, f);
            const size = `${(fs.statSync(full).size / 2 ** 30).toFixed(2)} GiB`;
            try {
              const iso = new IsoImage(full);
              try {
                const r = detectRecipe(iso);
                const win = !r && looksLikeUdfOnlyWindows(iso);
                return {
                  file: f,
                  size,
                  volume: iso.volumeId,
                  netboot: r ? r.id : win ? "windows-pe (needs 7-Zip)" : "unknown",
                  min_ram_gib: r?.minRamGiB,
                };
              } finally {
                iso.close();
              }
            } catch (e) {
              return { file: f, size, netboot: `unreadable: ${(e as Error).message}` };
            }
          });
        return [json(rows)];
      }),
  );

  server.registerTool(
    "netboot_start",
    {
      title: "Serve OS images to the target over the network (PXE/iPXE)",
      description:
        "Start barehand's built-in network boot server so the target can boot ISOs from this machine with no USB " +
        "stick or extra hardware. mode=proxy (real LAN): a proxyDHCP that coexists with the router's DHCP, plus " +
        "TFTP and HTTP; the target must be wired to the same network and have PXE/network boot enabled in its " +
        "BIOS. mode=lab: HTTP only, for the QEMU lab started with `lab/run-target.sh --netboot`. Serves an iPXE " +
        "menu with the given ISOs (booted with per-distribution recipes), netboot.xyz and local disk; `default` " +
        "boots automatically after `timeout_s`. Then boot the target from the network (boot menu: \"PXE\", " +
        "\"Network\", \"UEFI IPv4\") and follow progress with netboot_status. Secure Boot usually must be off for iPXE.",
      inputSchema: {
        isos: z.array(z.string()).default([]).describe("ISO paths or names in the image library"),
        mode: z.enum(["auto", "proxy", "lab"]).default("auto").describe("auto = lab for the qemu backend, proxy otherwise"),
        default: z.string().optional().describe('ISO name/id, "netbootxyz", "local" or "shell"; defaults to the first ISO'),
        timeout_s: z.number().min(0).max(600).default(5),
        extra_args: z.string().default("").describe("extra kernel arguments, e.g. autoinstall / inst.ks=… / nomodeset"),
        server_ip: z.string().optional().describe("this machine's IP on the target's network (auto-detected)"),
        http_port: z.number().int().min(1).max(65535).default(8067),
      },
    },
    ({ isos, mode, default: def, timeout_s, extra_args, server_ip, http_port }) =>
      guarded(async () => {
        if (nb) {
          await nb.stop();
          nb = undefined;
        }
        const effectiveMode = mode === "auto" ? (config.backend === "qemu" ? "lab" : "proxy") : mode;
        const isoPaths = isos.map(resolveIso);
        const defaultEntry = def
          ? ["netbootxyz", "local", "shell"].includes(def)
            ? def
            : `img-${path.basename(def).replace(/\.iso$/i, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 40)}`
          : undefined;
        const s = new NetbootServer({
          mode: effectiveMode,
          workDir: config.workDir,
          isoPaths,
          serverIp: server_ip,
          httpPort: http_port,
          defaultEntry,
          timeoutS: timeout_s,
          consoleArgs: consoleArgsFor(config.backend),
          extraArgs: extra_args,
        });
        await s.start();
        nb = s;
        const notes: string[] = [];
        if (effectiveMode === "lab") {
          notes.push("Start (or restart) the lab VM with: lab/run-target.sh --netboot  (it boots from the network first).");
        } else {
          notes.push(
            `Serving on ${s.serverIp}. Wire the target to this network, enable network boot in its BIOS ` +
              "(Network Stack / PXE OPROM), then pick the network entry in its boot menu.",
          );
        }
        for (const i of s.images) if (i.problem) notes.push(`${path.basename(i.isoPath)}: ${i.problem}`);
        return [
          json({
            mode: effectiveMode,
            menu_url: `${s.baseUrl}/boot.ipxe`,
            images: s.images.map((i) => ({ id: i.id, label: i.label, recipe: i.recipe?.id ?? null, notes: i.recipe?.notes ?? [], min_ram_gib: i.recipe?.minRamGiB })),
            notes,
          }),
          text(s.menu()),
        ];
      }),
  );

  server.registerTool(
    "netboot_status",
    {
      title: "Watch what the target fetched from the netboot server",
      description:
        "Recent DHCP/TFTP/HTTP activity from the netboot server: did the target ask for PXE, get iPXE, load the " +
        "menu, the kernel, the initrd, the root filesystem? Shows where a network boot is stuck.",
      inputSchema: { last: z.number().int().min(1).max(300).default(40) },
      annotations: { readOnlyHint: true },
    },
    ({ last }) =>
      guarded(async () => {
        if (!nb) return [text("Netboot server is not running.")];
        return [json({ running: true, base_url: nb.baseUrl, log: nb.log.slice(-last) })];
      }),
  );

  server.registerTool(
    "netboot_stop",
    {
      title: "Stop the netboot server",
      description: "Stop serving PXE/iPXE. Do this when the target has booted what it needed, so other machines on the LAN aren't affected.",
      inputSchema: {},
    },
    () =>
      guarded(async () => {
        if (!nb) return [text("Netboot server is not running.")];
        await nb.stop();
        nb = undefined;
        return [text("stopped")];
      }),
  );
}

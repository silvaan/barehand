/**
 * Network-boot recipes: how to boot a given ISO over HTTP.
 *
 * There is no generic "boot this ISO from the network" (iPXE sanboot loses
 * the disc once the OS kernel takes over). Each distribution has its own
 * initramfs parameter for fetching its root filesystem over HTTP, so we
 * detect the distribution from the files inside the ISO and use the right one.
 */
import type { IsoImage } from "./iso9660.js";

export interface BootContext {
  /** Base URL where files inside this ISO are served, ending in "/" (e.g. http://ip:port/img/sysresc/) */
  imgUrl: string;
  /** URL of the raw ISO file */
  isoUrl: string;
  /** Kernel console arguments to add, e.g. "console=tty0 console=ttyS0,115200" */
  consoleArgs: string;
  /** Extra kernel arguments from the agent/user */
  extraArgs: string;
}

export interface Recipe {
  id: string;
  label: string;
  /** Files (inside the ISO) the iPXE script loads; served under imgUrl. */
  kernel?: string;
  initrds: string[];
  /** Build the kernel command line. */
  cmdline?: (c: BootContext) => string;
  /** Free-form iPXE script lines, for recipes that don't fit kernel+initrd (wimboot). */
  script?: (c: BootContext) => string[];
  notes: string[];
  /** RAM needed on the target, roughly (fetch-ISO-into-RAM recipes). */
  minRamGiB?: number;
}

type Detector = (iso: IsoImage) => Recipe | undefined;

const first = (iso: IsoImage, paths: string[]) => paths.find((p) => iso.exists(p));

const detectors: Detector[] = [
  // SystemRescue (archiso based)
  (iso) => {
    if (!iso.exists("sysresccd/boot/x86_64/vmlinuz")) return undefined;
    const ucode = ["sysresccd/boot/intel_ucode.img", "sysresccd/boot/amd_ucode.img"].filter((p) => iso.exists(p));
    return {
      id: "systemrescue",
      label: `SystemRescue (${iso.volumeId})`,
      kernel: "sysresccd/boot/x86_64/vmlinuz",
      initrds: [...ucode, "sysresccd/boot/x86_64/sysresccd.img"],
      cmdline: (c) =>
        `archisobasedir=sysresccd archiso_http_srv=${c.imgUrl} ip=dhcp setkmap=us ${c.consoleArgs} ${c.extraArgs}`,
      notes: ["Root shell without password on every console.", "Loads the whole root filesystem into RAM (~1 GB)."],
      minRamGiB: 2,
    };
  },
  // Arch Linux install medium
  (iso) => {
    if (!iso.exists("arch/boot/x86_64/vmlinuz-linux")) return undefined;
    const ucode = ["arch/boot/intel-ucode.img", "arch/boot/amd-ucode.img"].filter((p) => iso.exists(p));
    return {
      id: "archiso",
      label: `Arch Linux (${iso.volumeId})`,
      kernel: "arch/boot/x86_64/vmlinuz-linux",
      initrds: [...ucode, "arch/boot/x86_64/initramfs-linux.img"],
      cmdline: (c) => `archisobasedir=arch archiso_http_srv=${c.imgUrl} ip=dhcp ${c.consoleArgs} ${c.extraArgs}`,
      notes: ["Autologin as root on tty1."],
      minRamGiB: 2,
    };
  },
  // Ubuntu (casper) desktop/server live
  (iso) => {
    const kernel = first(iso, ["casper/vmlinuz", "casper/hwe-vmlinuz"]);
    const initrd = first(iso, ["casper/initrd", "casper/initrd.lz", "casper/hwe-initrd"]);
    if (!kernel || !initrd) return undefined;
    return {
      id: "ubuntu-casper",
      label: `Ubuntu / casper (${iso.volumeId})`,
      kernel,
      initrds: [initrd],
      cmdline: (c) => `boot=casper ip=dhcp url=${c.isoUrl} cloud-config-url=/dev/null ${c.consoleArgs} ${c.extraArgs}`,
      notes: [
        "casper downloads the entire ISO into RAM before booting.",
        "Add 'autoinstall' plus a ds=nocloud-net datasource in extra_args for unattended server installs.",
      ],
      minRamGiB: 8,
    };
  },
  // Debian live (live-boot)
  (iso) => {
    const kernel = first(iso, ["live/vmlinuz"]);
    const initrd = first(iso, ["live/initrd.img"]);
    if (!kernel || !initrd || !iso.exists("live/filesystem.squashfs")) return undefined;
    return {
      id: "debian-live",
      label: `Debian live (${iso.volumeId})`,
      kernel,
      initrds: [initrd],
      cmdline: (c) =>
        `boot=live components fetch=${c.imgUrl}live/filesystem.squashfs ip=dhcp ${c.consoleArgs} ${c.extraArgs}`,
      notes: ["Fetches filesystem.squashfs into RAM."],
      minRamGiB: 4,
    };
  },
  // Windows media whose files are visible in the ISO 9660 tree (older or re-mastered ISOs)
  (iso) =>
    iso.exists("sources/boot.wim") && iso.exists("boot/bcd") && iso.exists("boot/boot.sdi")
      ? windowsRecipe(`Windows Setup / PE (${iso.volumeId})`)
      : undefined,
  // Fedora / RHEL family: installer tree or live image
  (iso) => {
    const kernel = first(iso, ["images/pxeboot/vmlinuz"]);
    const initrd = first(iso, ["images/pxeboot/initrd.img"]);
    if (!kernel || !initrd) return undefined;
    const live = iso.exists("LiveOS/squashfs.img") && !iso.exists("images/install.img");
    return {
      id: live ? "fedora-live" : "fedora-installer",
      label: `${live ? "Fedora live" : "Fedora/RHEL installer"} (${iso.volumeId})`,
      kernel,
      initrds: [initrd],
      cmdline: (c) =>
        live
          ? `root=live:${c.isoUrl} rd.live.image ip=dhcp ${c.consoleArgs} ${c.extraArgs}`
          : `inst.repo=${c.imgUrl} ip=dhcp ${c.consoleArgs} ${c.extraArgs}`,
      notes: live
        ? ["dracut downloads the ISO into RAM."]
        : ["Anaconda reads packages from the ISO over HTTP.", "Use inst.ks=<url> in extra_args for kickstart."],
      minRamGiB: live ? 6 : 3,
    };
  },
];

/** Windows: boot WinPE / Windows Setup's boot.wim through wimboot. */
export function windowsRecipe(label: string): Recipe {
  return {
    id: "windows-pe",
    label,
    initrds: [],
    script: (c) => [
      `kernel ${c.imgUrl.replace(/img\/[^/]+\/$/, "")}ipxe/wimboot`,
      `initrd ${c.imgUrl}boot/bcd BCD`,
      `initrd ${c.imgUrl}boot/boot.sdi boot.sdi`,
      `initrd ${c.imgUrl}sources/boot.wim boot.wim`,
      "boot",
    ],
    notes: [
      "Boots Windows Setup / WinRE (repair command prompt: bcdboot, chkdsk, diskpart).",
      "A full Windows install over the network also needs the install image shared over SMB (not yet automated).",
    ],
    minRamGiB: 2,
  };
}

export function detectRecipe(iso: IsoImage): Recipe | undefined {
  for (const d of detectors) {
    const r = d(iso);
    if (r) return r;
  }
  return undefined;
}

/** Microsoft ISOs keep everything in UDF; their ISO 9660 tree only has a README. */
export function looksLikeUdfOnlyWindows(iso: IsoImage): boolean {
  const readme = iso.readFile("README.TXT", 4096)?.toString("latin1") ?? "";
  return /UDF/i.test(readme) && iso.list().length <= 2;
}

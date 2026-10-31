/**
 * Destructive-command classifier.
 *
 * This is a tripwire, not a sandbox: it exists so an agent cannot wipe a disk
 * through the ordinary `shell_exec` tool by accident. Anything that matches
 * must go through `shell_exec_destructive`, which carries a written plan and
 * is never auto-approved by the MCP client.
 */

export interface Finding {
  rule: string;
  why: string;
  match: string;
}

const RULES: Array<{ rule: string; re: RegExp; why: string }> = [
  { rule: "mkfs", re: /\bmkfs(\.\w+)?\b|\bmke2fs\b|\bmkswap\b|\bmkntfs\b|\bmkdosfs\b/, why: "creates a filesystem (erases data)" },
  { rule: "wipefs", re: /\bwipefs\b/, why: "erases filesystem signatures" },
  { rule: "dd-write", re: /\bdd\b[^|;&\n]*\bof=\/dev\//, why: "raw write to a device with dd" },
  { rule: "shred", re: /\b(shred|blkdiscard|nvme\s+(format|sanitize))\b/, why: "irreversibly erases a device" },
  { rule: "sgdisk", re: /\bsgdisk\b[^|;&\n]*(--zap|-Z\b|-z\b|--clear|-o\b|--new|-n\b|--delete|-d\b|--largest-new|-N\b|--change-name|--typecode|-t\b)/, why: "modifies a GPT partition table" },
  { rule: "sfdisk-write", re: /\bsfdisk\b(?![^|;&\n]*(\s-d\b|--dump|\s-l\b|--list|--json|-J\b))/, why: "sfdisk writes partition tables unless used with --dump/--list" },
  { rule: "parted", re: /\bparted\b[^|;&\n]*\b(mklabel|mkpart|rm|resizepart|rescue)\b/, why: "modifies partitions" },
  { rule: "fdisk", re: /\b(g|c|)fdisk\b(?![^|;&\n]*\s-l\b)/, why: "interactive partition editor" },
  { rule: "redirect-to-disk", re: />\s*\/dev\/(sd[a-z]|nvme\d|vd[a-z]|hd[a-z]|mmcblk\d|disk\/)/, why: "redirects output onto a block device" },
  { rule: "rm-root", re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)[a-zA-Z]*\s+(\/|\/\*|\/mnt\/?|\/target\/?)(\s|$)/, why: "recursive delete of a root/mount point" },
  { rule: "lvm-remove", re: /\b(lvremove|vgremove|pvremove|mdadm\s+--zero-superblock|cryptsetup\s+(luksFormat|erase))\b/, why: "destroys volumes or encryption headers" },
  { rule: "efibootmgr-delete", re: /\befibootmgr\b[^|;&\n]*(\s-B\b|--delete-bootnum)/, why: "deletes a firmware boot entry" },
  { rule: "firmware-flash", re: /\b(flashrom|fwupdmgr\s+(install|update)|afulnx|afuefi)\b/, why: "flashes firmware (can brick the machine)" },
  // Windows (diskpart scripts, PowerShell, cmd)
  // Any diskpart invocation: its scripts can do anything, so treat them all as destructive.
  { rule: "diskpart", re: /\bdiskpart\b/i, why: "diskpart can repartition or wipe disks" },
  { rule: "win-format", re: /\bformat\s+[a-z]:|\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition|New-Partition)\b/i, why: "formats or repartitions a Windows disk" },
];

export function classify(command: string): Finding[] {
  const findings: Finding[] = [];
  for (const { rule, re, why } of RULES) {
    const m = re.exec(command);
    if (m) findings.push({ rule, why, match: m[0].trim() });
  }
  return findings;
}

export function isDestructive(command: string): boolean {
  return classify(command).length > 0;
}

/** Read-only commands whose output is saved before any destructive action. */
export const SNAPSHOT_COMMAND = [
  "echo '### lsblk'; lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,UUID,PARTUUID,MODEL,SERIAL,MOUNTPOINT 2>&1",
  "echo '### blkid'; blkid 2>&1",
  "for d in $(lsblk -dno NAME -e7,11); do echo \"### sfdisk -d /dev/$d\"; sfdisk -d /dev/$d 2>&1; done",
  "echo '### efibootmgr -v'; efibootmgr -v 2>&1",
].join("; ");

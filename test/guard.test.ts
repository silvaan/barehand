import { describe, expect, it } from "vitest";
import { classify, isDestructive } from "../src/safety/guard.js";

const destructive = [
  "mkfs.ext4 /dev/sda2",
  "mkfs -t vfat /dev/nvme0n1p1",
  "wipefs -a /dev/sdb",
  "dd if=ubuntu.iso of=/dev/sdc bs=4M status=progress",
  "sgdisk --zap-all /dev/sda",
  "sgdisk -n 1:0:+512M -t 1:ef00 /dev/nvme0n1",
  "parted -s /dev/sda mklabel gpt",
  "echo ',,L' | sfdisk /dev/sda",
  "fdisk /dev/sda",
  "cat image > /dev/sda",
  "rm -rf /mnt/",
  "efibootmgr -b 0003 -B",
  "cryptsetup luksFormat /dev/sda3",
  "flashrom -p internal -w bios.bin",
  "diskpart /s script.txt",
  "Clear-Disk -Number 0 -RemoveData",
  "format c: /fs:ntfs",
  "blkdiscard /dev/nvme0n1",
];

const safe = [
  "lsblk -f",
  "fdisk -l",
  "sfdisk -d /dev/sda",
  "sfdisk --json /dev/sda",
  "sgdisk -p /dev/sda",
  "parted -l",
  "dd if=/dev/sda of=/tmp/mbr.bin bs=512 count=1",
  "efibootmgr -v",
  "efibootmgr -o 0001,0002",
  "apt-get clean",
  "make clean",
  "grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=ubuntu",
  "mount /dev/sda2 /mnt && ls /mnt",
  "rm -rf /tmp/build",
  "smartctl -a /dev/sda",
];

describe("guard", () => {
  it.each(destructive)("flags %s", (cmd) => {
    expect(isDestructive(cmd)).toBe(true);
  });

  it.each(safe)("allows %s", (cmd) => {
    expect(classify(cmd)).toEqual([]);
  });
});

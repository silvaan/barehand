# Boot repair

Get a rescue shell first ([rescue-and-media](rescue-and-media.md)). Then always start with a read-only survey:

```
lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,PARTTYPENAME,MOUNTPOINT,MODEL,SERIAL
blkid
[ -d /sys/firmware/efi ] && echo UEFI || echo LEGACY
efibootmgr -v                       # UEFI only
```

Identify: the ESP (vfat, type "EFI System", usually 100–600 MB), the Linux root, a separate `/boot` if any,
Windows partitions (ntfs; "Microsoft reserved"), LUKS/LVM/RAID layers. **Boot the rescue in the same mode
(UEFI vs legacy) as the installed system**, or bootloader reinstalls will target the wrong thing.

## Linux: GRUB missing / `grub rescue>` / "no such device"

Mount and chroot (adjust device names to the survey):

```
mount /dev/nvme0n1p2 /mnt
mount /dev/nvme0n1p1 /mnt/boot/efi            # ESP (check /mnt/etc/fstab for the right mountpoint)
for d in dev proc sys run; do mount --rbind /$d /mnt/$d; done
mount -t efivarfs efivarfs /mnt/sys/firmware/efi/efivars 2>/dev/null
```

Then, in the chroot (`chroot /mnt sh -c '…'` via `shell_exec`):

| Distro family | Reinstall + regenerate |
|---|---|
| Debian/Ubuntu | `grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=ubuntu && update-grub` |
| Fedora/RHEL | `dnf reinstall shim-x64 grub2-efi-x64 && grub2-mkconfig -o /boot/grub2/grub.cfg` |
| Arch | `grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=GRUB && grub-mkconfig -o /boot/grub/grub.cfg` |
| Legacy BIOS | `grub-install /dev/sdX` (the **disk**, not a partition) + regenerate |

`grub-install` writes to the ESP and NVRAM but doesn't repartition, so it passes the guard. Still state what you're doing.

Encrypted root: `cryptsetup open /dev/… cryptroot` first (ask the user for the passphrase; never store it).
LVM: `vgchange -ay`.

## UEFI entry missing (disk boots only via "boot from file")

```
efibootmgr -c -d /dev/nvme0n1 -p 1 -L "ubuntu" -l '\EFI\ubuntu\shimx64.efi'
```

Some firmware ignores custom entries: copy the loader to the fallback path `\EFI\BOOT\BOOTX64.EFI`.

## Boots to an emergency shell

Usually `/etc/fstab` (a UUID changed after cloning or reformatting) or a failed fsck. Compare `blkid` with
fstab, fix the UUIDs, then `fsck -f` the unmounted filesystem if needed.

## Windows won't boot

From Windows installation media → Repair your computer → Troubleshoot → Command Prompt (or WinRE):

```
diskpart → list vol         (find the Windows volume letter and the ESP; assign a letter to the ESP: sel vol N, assign letter=S)
bcdboot C:\Windows /s S: /f UEFI
```

- `diskpart` is treated as destructive even for `list`, so plan it and get approval. In the GUI it is typed
  with `type_text`; still follow the destructive rules (state the plan, wait for the user's OK).
- Automatic Repair loop: try `bcdboot` first, then `chkdsk C: /f`, then `sfc /scannow /offbootdir=C:\ /offwindir=C:\Windows`.
- **BitLocker**: if the drive is encrypted (`manage-bde -status`), the user needs the recovery key
  (aka.ms/myrecoverykey). Changing boot settings can trigger the recovery prompt, so warn first.

## Dual boot: Windows disappeared from GRUB

`os-prober` is disabled by default on recent GRUB. Set `GRUB_DISABLE_OS_PROBER=false` in `/etc/default/grub`,
install `os-prober`, then regenerate the config.

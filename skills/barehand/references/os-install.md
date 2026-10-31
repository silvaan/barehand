# OS installation

## 0. Before anything

- Confirm with the user **which disk** gets erased and what's on the others. Show `lsblk` with model, serial and size.
- Ask about data to keep. If there's any doubt, back up first or stop.
- Check firmware mode: install in **UEFI** mode with CSM off unless the hardware is too old for it.

## 1. Get the image

Use official sources and checksums only:

| OS | Image | Checksum |
|---|---|---|
| Ubuntu | `https://releases.ubuntu.com/<ver>/` | `SHA256SUMS` in the same directory |
| Debian | `https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/` | `SHA256SUMS` |
| Fedora | `https://fedoraproject.org/workstation/download` | `*-CHECKSUM` file |
| Windows 10/11 | microsoft.com/software-download (links are session-bound: let the user fetch them, or use the Media Creation Tool) | hashes are published on the download page |

```
iso_download { url, sha256sums_url }   →   job_status { id }   (until done, verified: true)
```

## 2. Boot it

- **Virtual media** (QEMU, KVM appliances): `media_attach` → reset → boot-menu key → choose the CD/virtual drive.
- **DIY hardware**: network boot (iPXE, served by the controller; *planned*), or ask the human to plug in a
  Ventoy stick with the ISO copied onto it, then pick it in the boot menu.

## 3. Install unattended when possible

Typing into installers screen by screen works, but it is slow and brittle. Prefer the installer's own automation:

| OS | Mechanism |
|---|---|
| Ubuntu 22.04+ | autoinstall (`autoinstall` kernel arg + `user-data` from a second CD/HTTP) |
| Debian | preseed (`auto url=…` at the boot prompt) |
| Fedora/RHEL | kickstart (`inst.ks=…`) |
| Windows | `autounattend.xml` at the root of any attached media |

Kernel arguments are typed at the boot menu (`e` in GRUB, Tab in ISOLINUX) with US layout.

## 4. Partitioning (manual layouts)

Write the plan out first, for example:

```
/dev/nvme0n1 (Samsung 980 · S64DNX0R123456 · 931.5G): new GPT
  p1  1 GiB    EFI System (vfat)     /boot/efi
  p2  rest     Linux filesystem (ext4)  /
```

Then one `shell_exec_destructive` per step (label, then partitions, then filesystems), each with `target_disk`.
Use `sgdisk`/`parted -s` (scriptable), never interactive `fdisk`.

Dual boot next to Windows: shrink Windows **from Windows** (Disk Management) or with `ntfsresize` after
`chkdsk`. Never resize a BitLocker volume without suspending BitLocker. Reuse the existing ESP: don't create a second one.

## 5. Windows specifics

- Windows 11 requires TPM 2.0 + Secure Boot. On real hardware, enable fTPM/PTT in the BIOS rather than bypassing it.
- Some Intel laptops need the RST/VMD driver to see the NVMe disk ("Load driver"), or VMD turned off in the BIOS.
- Use an account and product key the **user** provides. Never invent or bypass licensing.

## 6. After install

Eject media, cold boot from disk, confirm the login screen. Install updates and drivers if asked.

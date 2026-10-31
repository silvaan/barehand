# Lab: develop against a VM you can break

The QEMU backend drives a local VM exactly like the DIY hardware drives a real PC: screendump is the
capture card, `input-send-event` is the USB keyboard, a serial socket is the USB console, and the virtual
CD-ROM is the boot media.

## Setup

```bash
# Debian/Ubuntu
sudo apt install qemu-system-x86 qemu-utils ovmf poppler-utils ffmpeg
# Fedora: sudo dnf install qemu-system-x86 edk2-ovmf poppler-utils ffmpeg
# macOS:  brew install qemu poppler ffmpeg
```

## Run

```bash
lab/run-target.sh --iso ~/Downloads/systemrescue-11.02-amd64.iso --vnc :1   # watch it with a VNC viewer
npx barehand doctor                                                          # should connect and capture
```

The VM state (disk, UEFI variables, sockets) lives in `~/.cache/barehand/lab/`. `--fresh` wipes it.

## Network boot

`lab/run-target.sh --netboot` boots from barehand's netboot server first (call `netboot_start` before);
`--netboot-fallback` behaves like a real PC: disk first, network only when the disk fails or is picked in the
firmware's boot manager. SystemRescue booted this way logs root in on the serial console by itself, with the
console arguments already on the kernel command line. See [`docs/netboot.md`](../docs/netboot.md).

## Scenarios

Broken-on-purpose customer PCs with an automatic PASS/FAIL grade live in [`scenarios/`](scenarios/README.md):
`esp-wiped`, `fstab-typo`, `kernel-deleted`, `grub-cfg-missing`. Planned next: wrong boot order (BIOS setup),
Windows BCD deleted (WinRE + `bcdboot`), BitLocker-aware repairs.

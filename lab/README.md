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

## A rescue system with a console

`shell_exec` needs a root shell on the serial line. With [SystemRescue](https://www.system-rescue.org/)
(no root password on the live system):

1. At its boot menu, press **Tab** (BIOS) or **e** (UEFI) and append `console=ttyS0,115200` to the kernel line.
2. Log in as `root` on the serial console (`console_send "root\n"`).

On real hardware, the console is the ESP32's USB CDC port, so use `console=ttyACM0,115200` instead.
A purpose-built barehand rescue image that autologins on every console is on the roadmap.

## Scenarios (planned)

Scripts that build a working install and then break it in a known way, used as evals for the playbooks:

| Scenario | Breakage | Expected repair |
|---|---|---|
| `grub-wiped` | ESP's `grubx64.efi` deleted | chroot + `grub-install` |
| `efi-entry-gone` | NVRAM boot entry deleted | `efibootmgr -c` |
| `wrong-boot-order` | CD before disk, no media | BIOS setup or `efibootmgr -o` |
| `fstab-bad-uuid` | root UUID typo in fstab | emergency shell, fix fstab |
| `windows-bcd` | BCD store deleted | WinRE + `bcdboot` |

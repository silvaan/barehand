# Rescue shell, console and boot media

## Getting a console

`shell_exec` needs a root shell on the target's serial line:

| Backend | Target device |
|---|---|
| QEMU lab | `ttyS0` |
| DIY (ESP32-S3) | `ttyACM0` (USB CDC) |

If the system was network-booted by barehand, the console arguments are already on the kernel command line:
skip to step 2. Otherwise, with SystemRescue (root, no password):
1. At its boot menu (US layout): UEFI → `e` on the entry, append `console=tty0 console=ttyS0,115200`
   (or `ttyACM0`) to the `linux` line, then Ctrl-X. BIOS/ISOLINUX → Tab, append, Enter.
2. `console_read { until: "login:", wait_ms: 300000 }` returns as soon as the prompt appears, then
   `console_send { data: "root\n" }`.
3. `shell_exec { command: "uname -a" }` to confirm.

If no getty appears on ttyACM0, start one from the local screen with `type_text`:
`systemctl start serial-getty@ttyACM0` (US layout on a live system, unless it was configured otherwise).

Any live Linux works (Ubuntu live: `sudo -i`, then start a getty the same way). Without a console you can
still type commands with `type_text` and read the screen, but it's slow: get the console first.

## Boot media

**Default: network boot.** It needs no extra hardware and works with every backend.

1. `iso_list` → is the ISO there and does it have a recipe? If not, `iso_download` it first.
2. `netboot_start { isos: [...], default: "<iso>" }` (mode auto: `lab` for QEMU, `proxy` on a real LAN).
   Read the returned notes: RAM needed, Secure Boot, privileges.
3. Make the target boot from the network:
   - one-time boot menu key (`key_spam_until_change { key: "f12", before: "reset" }`) → pick "PXE"/"UEFI IPv4"/"Network";
   - if no network entry exists: enable "Network Stack"/"PXE OPROM" in the BIOS, save, retry;
   - lab: `lab/run-target.sh --netboot` boots from the network first.
4. `netboot_status` to follow it: DHCP → `ipxe.efi` → `/boot.ipxe` → kernel → initrd → rootfs. If it stalls,
   the last line says where (no DHCP line means the target isn't on our L2 network or PXE is off).
5. `netboot_stop` once the system is up.

The kernel command line already includes the console arguments for `shell_exec`. SystemRescue logs root in on
the console by itself: `console_read { until: "automatic login", wait_ms: 600000 }`, then `shell_exec` right away.
In the lab (no KVM) that takes about 2 minutes from reset; on real hardware, well under a minute.

| Fallbacks | How |
|---|---|
| QEMU, KVM appliances | `media_attach { path }` → reset → boot menu → the CD/virtual drive |
| No Ethernet on the target | Ventoy stick (human plugs it in once, keeps ISOs on it) |

`media_eject` when done, otherwise the next boot may go back into the installer.

## Console hygiene

- `shell_exec` prepares the shell (`stty -echo`, empty prompt, `LC_ALL=C`). If output looks garbled, run
  `console_send { data: "\x03\n" }` and try again.
- Long jobs (fsck, copies): raise `timeout_s`. A timed-out command gets a Ctrl-C.
- Interactive programs (passwd, cryptsetup prompts): use `console_send` + `console_read`.

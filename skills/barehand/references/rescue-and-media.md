# Rescue shell, console and boot media

## Getting a console

`shell_exec` needs a root shell on the target's serial line:

| Backend | Target device |
|---|---|
| QEMU lab | `ttyS0` |
| DIY (ESP32-S3) | `ttyACM0` (USB CDC) |

With SystemRescue (root, no password):
1. At its boot menu (US layout): UEFI → `e` on the entry, append `console=tty0 console=ttyS0,115200`
   (or `ttyACM0`) to the `linux` line, then Ctrl-X. BIOS/ISOLINUX → Tab, append, Enter.
2. `console_read { wait_ms: 15000 }` until a `login:` prompt appears, then `console_send { data: "root\n" }`.
3. `shell_exec { command: "uname -a" }` to confirm.

If no getty appears on ttyACM0, start one from the local screen with `type_text`:
`systemctl start serial-getty@ttyACM0` (US layout on a live system, unless it was configured otherwise).

Any live Linux works (Ubuntu live: `sudo -i`, then start a getty the same way). Without a console you can
still type commands with `type_text` and read the screen, but it's slow: get the console first.

## Boot media

| Backend | How |
|---|---|
| QEMU, KVM appliances | `media_attach { path }` → reset → boot menu → the CD/virtual drive |
| DIY | Ventoy stick (human plugs it in once, keeps ISOs on it) or network boot (planned) |

`media_eject` when done, otherwise the next boot may go back into the installer.

## Console hygiene

- `shell_exec` prepares the shell (`stty -echo`, empty prompt, `LC_ALL=C`). If output looks garbled, run
  `console_send { data: "\x03\n" }` and try again.
- Long jobs (fsck, copies): raise `timeout_s`. A timed-out command gets a Ctrl-C.
- Interactive programs (passwd, cryptsetup prompts): use `console_send` + `console_read`.

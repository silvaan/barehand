# Firmware link protocol

ASCII lines over the ESP32's UART link (921600 8N1). Host → device lines are commands, and the device answers
each with exactly one `OK …` or `ERR …`, **in order**. Two other kinds of device lines can arrive at any
time and are not answers: `CD` (console data) and `EV` (events). Anything else (e.g. ROM boot messages) is
ignored by the host.

## Commands (host → device)

| Command | Meaning | Answer |
|---|---|---|
| `PING` | handshake | `OK barehand-fw <ver> usb=mounted\|unmounted` |
| `KD <mods> <usage>` | key down (hex) | `OK` |
| `KU <mods> <usage>` | key up (hex) | `OK` |
| `KT <mods> <usage> <ms>` | tap: down, wait, up | `OK` |
| `KR` | release all keys and buttons | `OK` |
| `MR <dx> <dy>` | relative mouse move (split into ±127 steps) | `OK` |
| `MA <x> <y>` | absolute pointer, 0..32767 each | `OK` |
| `MB <mask>` | buttons: bit0 left, bit1 right, bit2 middle | `OK` |
| `MW <delta>` | wheel, ±127 | `OK` |
| `PP <ms>` | hold the power button for ms (20..15000) | `OK` after release |
| `PR <ms>` | hold the reset button | `OK` after release |
| `PS` | power LED sense | `OK 1` (on) / `OK 0` (off) |
| `CW <base64>` | write bytes to the target's CDC serial port (≤ 384 raw bytes) | `OK` |

`mods` is the USB HID modifier byte (`01` LCtrl, `02` LShift, `04` LAlt, `08` LGui, `10` RCtrl, `20` RShift,
`40` RAlt/AltGr, `80` RGui). `usage` is a HID Keyboard/Keypad page usage. Layout translation happens on the
host (`src/hal/keymap.ts`), so the firmware is layout-agnostic.

HID commands answer `ERR target USB not mounted` while the target is off or its port is unpowered.

## Device → host, unsolicited

| Line | Meaning |
|---|---|
| `CD <base64>` | bytes the target wrote to its serial port (≤ 96 raw bytes per line) |
| `EV READY barehand-fw <ver>` | firmware booted |
| `EV USB mounted\|unmounted\|suspended\|resumed` | target USB state, a good proxy for "target is on" |
| `EV LED <hex>` | keyboard LEDs set by the target: bit0 Num, bit1 Caps, bit2 Scroll Lock |

## USB device presented to the target

| Interface | Class | Why |
|---|---|---|
| 0 | HID boot keyboard (subclass 1, protocol 1) | UEFI setup screens only bind boot-protocol keyboards |
| 1 | HID boot mouse (relative) | works in firmware that supports a mouse at all |
| 2 | HID absolute pointer | precise clicks on OS desktops/installers |
| 3–4 | CDC-ACM | `/dev/ttyACM0` console for the rescue system |

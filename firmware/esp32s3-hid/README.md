# barehand firmware: ESP32-S3

Turns an **ESP32-S3-DevKitC-1** into the "hands" of barehand: a USB keyboard, mouse and serial port for the
target PC, controlled over the board's second USB port. Protocol: [`docs/protocol.md`](../../docs/protocol.md).
Wiring: [`docs/hardware.md`](../../docs/hardware.md).

> ⚠️ **Status:** written but not yet validated on hardware. Expect to fix descriptor or build details on
> first flash, and please open an issue with what you find.

## Why ESP-IDF and not Arduino

UEFI firmware (EDK2's `UsbKbDxe` and most vendor forks) only binds keyboards whose HID interface declares the
**boot subclass and keyboard protocol**. The Arduino-ESP32 HID library puts every device in one HID interface
with report IDs, which can work in an OS but not in BIOS setup, exactly where barehand needs it most. Here
the TinyUSB descriptors are written by hand: one interface per device, keyboard and mouse in boot protocol.

## Build & flash

Requires [ESP-IDF 5.1+](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/get-started/).

```bash
cd firmware/esp32s3-hid
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/ttyUSB0 flash      # the board's "UART" port
```

Then plug the **"USB"** port into the target and the **"UART"** port into the controller, and check:

```bash
npx barehand ports                 # find the UART bridge (CP210x / CH343)
BAREHAND_BACKEND=diy BAREHAND_DIY_PORT=/dev/ttyUSB0 npx barehand doctor
```

## Pins

| GPIO | Use |
|---|---|
| 19 / 20 | native USB D− / D+ (fixed) |
| 43 / 44 | UART0 TX / RX → on-board USB-UART bridge (fixed) |
| 4 | power button optocoupler (active high) |
| 5 | reset button optocoupler (active high) |
| 6 | power LED sense (input pull-up, low = LED on) |

## Notes

- The USB VID/PID is a placeholder from Espressif's range (`303A:8B4D`). A proper PID will come from the
  Espressif or pid.codes pool before any release.
- IDF logging is disabled because UART0 is the command link. The ROM bootloader still prints a few lines at
  reset, and the host ignores them.

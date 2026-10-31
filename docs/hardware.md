# Hardware

barehand needs three things on the target PC: **eyes** (its video output), **hands** (a USB keyboard
and mouse) and, optionally, a **finger on the power button**. This page explains the cheapest way to get
all three and the trade-offs of the alternatives.

## Tier 0: QEMU lab (no hardware)

Develop and test everything against a VM first. See [`lab/README.md`](../lab/README.md).

## Tier 1: DIY kit ⭐ recommended

### Shopping list

| Part | Notes | ~US$ | ~R$ |
|---|---|---|---|
| USB HDMI capture card (MS2109 / MS2130) | The ubiquitous "HDMI to USB" dongle. Shows up as a UVC webcam, no driver needed. | 8–15 | 40–80 |
| **ESP32-S3-DevKitC-1** (any N8/N16 variant) | Must be the **S3** (native USB). The DevKitC-1 has two USB-C ports, which is the point. | 6–12 | 50–90 |
| 2–3× PC817 optocoupler | Optional: power button, reset button, power LED sense. | <1 | 2–5 |
| 3× 330 Ω – 1 kΩ resistors | For the optocoupler LEDs. | <1 | 1 |
| Dupont jumpers, 2× USB-C cables | | 2–4 | 10–20 |

**Total: about US$20 / R$100–200.** No soldering is needed if you use a breadboard and Dupont wires on
the front-panel header.

### Topology

```
                         ┌──────────────────────── Target PC ───────────────────────┐
                         │                                                          │
 Controller PC           │  HDMI out ──────────────┐                                │
 (runs the agent +       │                         │                                │
  barehand MCP server)   │  USB port ◄─────────┐   │      Front-panel header        │
                         │                     │   │      PWR_SW  RST_SW  PLED      │
                         └─────────────────────┼───┼────────▲───────▲───────┬───────┘
                                               │   │        │       │       │
        USB ◄──────── capture card ◄───────────┼───┘        │       │       │
                                               │            │       │       │
        USB ◄── [UART] ESP32-S3-DevKitC-1 [USB]┘   GPIO4 ─opto─┘       │       │
                       (CP210x)    (native)        GPIO5 ─opto─────────┘       │
                                                   GPIO6 ◄─opto────────────────┘
```

- **ESP32 "USB" port (native, GPIO19/20) → target PC.** Enumerates as a composite device: boot keyboard,
  mouse and a CDC serial port (`/dev/ttyACM0` in the rescue Linux, `COMx` in Windows).
- **ESP32 "UART" port → controller PC.** The command link. Because the board is powered from this side,
  the firmware stays alive while the target is off or rebooting.
- **Capture card → controller PC.** If the target has a dedicated GPU, use *its* output.

### Front-panel wiring (optional)

Wire the optocouplers **in parallel** with the case buttons so the case's own buttons keep working.

```
Power / reset button                     Power LED sense
────────────────────                     ───────────────
ESP32 GPIO4 ──[330Ω]──► PC817 pin1 (A)   PLED+ ──[330Ω]──► PC817 pin1 (A)
ESP32 GND  ───────────► PC817 pin2 (K)   PLED− ──────────► PC817 pin2 (K)
PWR_SW+    ◄────────── PC817 pin4 (C)    ESP32 GPIO6 ◄──── PC817 pin4 (C)  (INPUT_PULLUP)
PWR_SW−    ◄────────── PC817 pin3 (E)    ESP32 GND  ◄───── PC817 pin3 (E)
```

- The optocoupler keeps the PC and the ESP32 electrically isolated.
- Polarity matters on the switch side: the collector goes to the pin with voltage (`+`), the emitter to
  ground (`−`). Check your motherboard manual. If pressing does nothing, swap pins 3/4.
- Same circuit on GPIO5 for `RST_SW` if your case has a reset button header.
- GPIO6 reads **LOW while the power LED is on**.

### Gotchas

- **Use a USB 2.0 port on the target** if you can. Some BIOSes only initialize certain ports during POST.
  "Legacy USB support" (on by default nearly everywhere) must stay enabled.
- **Laptops** often show the BIOS only on the internal panel, not on HDMI. Fallback: point a cheap USB
  webcam at the screen. barehand treats any UVC device as eyes.
- **VGA / DisplayPort only?** DisplayPort to HDMI passive adapters work. VGA needs an active VGA to HDMI converter.
- **No power header** (laptops, all-in-ones): power control is unavailable, and the skill asks the human to
  press the button.
- **WSL2:** USB capture cards don't work reliably through `usbipd` (the stock WSL kernel lacks `uvcvideo`).
  Run barehand natively on Windows, where capture goes through ffmpeg/DirectShow. The serial link works either way.

### Boot media without virtual media

The ESP32 can't emulate a multi-GB USB stick at a usable speed (USB full-speed ≈ 1 MB/s). Instead:

1. **Network boot (preferred):** barehand's built-in server (`netboot_start`) answers the target's PXE
   request and serves the ISO over HTTP on the LAN or a direct cable. It coexists with the router's DHCP.
   barehand can enable PXE in the BIOS by itself. See [`netboot.md`](netboot.md).
2. **Ventoy stick:** plug it in once, drop ISOs on it, and the agent picks one from the Ventoy menu.

## Tier 2: KVM appliances (planned backends)

| Device | Video | HID | Virtual media | Power | Notes |
|---|---|---|---|---|---|
| **PiKVM** (v3/v4 or DIY Pi 4) | ✅ | ✅ | ✅ | ✅ ATX board | Most mature. HTTP + WebSocket API. |
| **NanoKVM** (Sipeed) | ✅ | ✅ | ✅ | ✅ (full version) | Very cheap. HTTP API. |
| **JetKVM** | ✅ | ✅ | ✅ | ⚠️ extension | Low latency, open source. |
| **TinyPilot** | ✅ | ✅ | ✅ | ❌ | Commercial, HTTP API. |

These add standalone operation, built-in virtual media and remote access. The backend interface
(`src/hal/types.ts`) is designed so each one is a thin adapter.

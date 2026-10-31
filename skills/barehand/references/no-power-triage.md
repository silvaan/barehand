# No power / no POST triage

Most "won't turn on" problems are physical. You can't swap parts, but you can observe (screen, power LED,
USB enumeration events) and guide the human through a disciplined elimination. Change **one** thing at a time
and observe after each change.

## 1. Classify the symptom

| Observation | Likely area |
|---|---|
| `power_state` = off after `power_press`, no fans | wall/PSU switch, PSU, front-panel wiring, 24-pin/8-pin EPS, shorted board |
| Fans spin briefly, then stop (repeats) | short, CPU power, RAM, PSU protection |
| Powered on, screen black, no USB "mounted" event | stuck before USB init: CPU/RAM/board; check debug LEDs or POST code |
| Powered on, screen black, keyboard enumerates | video: wrong output (iGPU vs dGPU), cable, capture input, monitor-only signal |
| POST error text / beeps | read it, then look up the code in **this board's manual** |
| Loops to POST forever | RAM training (wait ~2 minutes after a CMOS reset or a new DIMM), unstable OC/XMP |

The firmware's `EV USB mounted` event (DIY backend) is a cheap "reached USB init" signal even with no picture.

## 2. Gather evidence

- **Debug LEDs (Q-LED / EZ Debug: CPU, DRAM, VGA, BOOT)** or a **two-digit POST code display**: ask the human
  to read them, or point a webcam at the board. Look up the meaning in the manual
  (`manual_search "Q-LED"` / `"debug code"`). Codes are vendor-specific: never guess from memory.
- **Beep codes**: ask for the pattern (long/short counts). Look it up for the BIOS vendor (AMI, Award/Phoenix)
  or the OEM (Dell, HP and Lenovo use their own beep and LED blink codes).
- **OEM laptops/desktops**: power-button LED blink patterns (HP, Dell ePSA, Lenovo). Fetch the OEM's
  maintenance/service manual for the exact model.

## 3. Standard elimination order (guide the human)

1. Wall outlet, PSU rocker switch, cable. Try another outlet.
2. Front panel: is `PWR_SW` on the right pins? (`manual_search "front panel header"`). Shorting the two
   `PWR_SW` pins briefly with a screwdriver rules out the case button.
3. Power connectors seated: 24-pin ATX, 4+4/8-pin EPS CPU, GPU PCIe power.
4. **Clear CMOS** (jumper or battery out for a few minutes, power cord unplugged). The manual has the jumper location.
5. Minimal config: one DIMM in the slot the manual recommends (often A2), no dGPU if there's an iGPU,
   no extra drives or USB devices.
6. Swap the DIMM / try the other slot. Then the PSU if a known-good one is available.
7. Still dead: board or CPU. Say so honestly and stop.

## 4. Report

State what was observed, what was ruled out (and how), the most likely cause, and the next physical step.
Don't overclaim: "the PSU or motherboard; a known-good PSU would separate the two" is a good answer.

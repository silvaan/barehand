<div align="center">

# 🖐️ barehand

**An AI PC technician that works *below* the operating system.**

Give an agent eyes on another computer's screen and hands on its keyboard, power button and boot media,<br>
then let it fix boot loaders, tweak the BIOS, partition disks and install Windows or Linux like a human tech would.

[![status](https://img.shields.io/badge/status-early%20development-orange)](#roadmap)
[![MCP](https://img.shields.io/badge/MCP-server-6E56CF)](https://modelcontextprotocol.io)
[![skill](https://img.shields.io/badge/agent-skill-0A7EA4)](skills/barehand/SKILL.md)
[![hardware](https://img.shields.io/badge/hardware-~US%2420-2EA44F)](#hardware)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](package.json)

</div>

---

## Why

Remote-desktop tools stop working exactly when you need them most: when the machine **won't boot**.
GRUB is gone, the EFI entry vanished, Windows is stuck in an automatic repair loop, the boot order is wrong,
or the disk has to be wiped and reinstalled. Those problems live in the BIOS, the boot menu and the
installer, where no software agent can reach.

**barehand** reaches them with a few dollars of hardware sitting *outside* the target PC:

| The target PC sees… | …which is really |
|---|---|
| 🖥️ a monitor | an HDMI capture card the agent looks through |
| ⌨️ a USB keyboard & mouse | a microcontroller the agent types through |
| 🔌 a serial port | a text console into the rescue system, with no network needed |
| 💿 a boot device | an ISO the agent downloaded and served over the network |
| 🔘 someone pressing the power button | an optocoupler on the front-panel header |

The agent never needs anything installed on the broken machine.

## What it can do

<table>
<tr>
<td width="50%" valign="top">

### 🩺 Diagnose
- Won't power on? Reads POST codes, debug LEDs and beep codes and walks you through a hardware triage tree
- Stuck on POST, black screen, boot loop, `grub rescue>`
- Reads SMART, `dmesg` and disk layouts from a rescue shell

### 🔧 Repair
- Reinstall / repair **GRUB** and **systemd-boot**
- Rebuild **EFI** entries and Windows BCD (`bcdboot`)
- Fix the boot order (`efibootmgr` or the BIOS setup)
- Recover from Windows automatic-repair loops

</td>
<td width="50%" valign="top">

### 💿 Install
- Download ISOs and **verify checksums**
- Unattended **Linux** installs (autoinstall, preseed, kickstart)
- Unattended **Windows** installs (`autounattend.xml`)
- Partitioning plans that are reviewed before anything is written

### ⚙️ BIOS / UEFI
- Enter setup reliably by hammering the right key during the POST window
- Toggle Secure Boot, virtualization, CSM, SATA mode
- Change the boot order and boot once from a device

</td>
</tr>
<tr>
<td colspan="2" valign="top">

### 📚 Knows the hardware it's working on
- **Identifies the machine**: board vendor, model and BIOS version from the POST screen, the BIOS setup or `dmidecode` in the rescue shell
- **Fetches the real documentation**: motherboard/laptop manuals, front-panel header pinouts, Q-LED / POST-code / beep-code tables, BIOS setup keys
- **Reads only what matters**: manuals are cached, converted to text and searched page by page, so a 200-page PDF costs a few paragraphs of context, with page citations

</td>
</tr>
</table>

## How it works

```mermaid
flowchart LR
    A["🤖 Agent<br/>(Claude Code, Codex, …)"] -- "MCP" --> S["barehand<br/>MCP server"]
    S --> H{{"Hardware<br/>abstraction"}}
    H --> Q["🧪 QEMU lab"]
    H --> D["🔩 DIY: capture card<br/>+ ESP32-S3"]
    H --> K["📦 PiKVM / NanoKVM /<br/>JetKVM (planned)"]
    D -. "HDMI" .-> T(["💻 Target PC"])
    D -. "USB HID + serial" .-> T
    D -. "ATX power header" .-> T
```

It is built on one design rule: **eyes and hands only to bootstrap, a shell for real work.**

1. **Pixels + keystrokes** where nothing else exists: POST, BIOS setup, boot menus, the first installer screens.
   Time-critical work such as "spam F2 until the screen changes" runs in the server, never in the model's loop.
2. **Boot a rescue Linux** that opens a shell over the USB serial link.
3. **Everything else is text:** `shell_exec` with exit codes, deterministic and verifiable.

Two layers ship together, the same way as their sibling projects:

- **MCP server** for primitive, hardware-agnostic tools: `screen_capture`, `screen_wait`, `key_combo`, `key_spam_until_change`, `type_text`, `power_press`, `media_attach`, `shell_exec`, `iso_download`, `hw_identify`, `manual_fetch`, `manual_search`, …
- **Skill** for the technician's playbooks: how to repair GRUB, how to find a BIOS setup key, how to plan a partition layout, when to stop and ask the human.

## Hardware

Start with no hardware at all, and buy the cheap kit when you need a real machine.

| Tier | What | Approx. cost | Gets you |
|---|---|---|---|
| **0 · Lab** | QEMU + OVMF on your own machine | free | Every tool and playbook, against VMs you can break on purpose |
| **1 · DIY** ⭐ | USB HDMI capture card (MS2109) + **ESP32-S3-DevKitC-1** + 2× PC817 optocouplers | **~US$20** | Screen, keyboard/mouse, serial console, power button & LED on a real PC |
| **2 · Appliance** | PiKVM, NanoKVM or JetKVM | US$40 – 300 | Adds built-in virtual media, a standalone box and remote access *(backend planned)* |

**Why the ESP32-S3?** The DevKitC-1 has **two USB-C ports**. The native one plugs into the target and
shows up as a keyboard, mouse *and* serial port (TinyUSB composite device). The UART one plugs into your
controller PC. One board, no extra adapters. (A classic Arduino Uno can't do this: it has no native USB.)

**Boot media on DIY:** the controller serves ISOs over the network (iPXE / netboot) or you plug in a Ventoy stick once.

More detail, wiring and a shopping list: [`docs/hardware.md`](docs/hardware.md).

## Safety first

An agent that can format disks needs guardrails that don't depend on it behaving perfectly:

- 🛑 **Destructive commands are a separate tool.** `mkfs`, `wipefs`, `dd of=`, `sgdisk --zap`, `diskpart clean`, … are refused by `shell_exec` and must go through `shell_exec_destructive`, which carries a written plan, so your MCP client asks you every time.
- 🔎 **Disks are identified by model + serial + size**, never just by `/dev/sdX`.
- 💾 **The layout is snapshotted before changes**: `sfdisk -d`, `efibootmgr -v` and the ESP contents.
- 🧱 **No autonomous firmware flashing. Ever.**
- ✅ **Every downloaded ISO is checksum-verified** before it is booted.

## Roadmap

- [x] Project skeleton, hardware abstraction layer
- [ ] QEMU lab backend + broken-on-purpose scenarios
- [ ] MCP tools: screen, keyboard, mouse, power, media, console
- [ ] ESP32-S3 firmware (HID + CDC + power), DIY backend
- [ ] Rescue image with an auto-login serial shell
- [ ] Playbooks: GRUB/EFI repair, boot order, Linux install
- [ ] Hardware knowledge: `hw_identify`, manual download + page-level search, POST/beep code tables
- [ ] Playbooks: Windows install, BIOS navigation, no-power triage
- [ ] `npx barehand setup --client …` for one-command registration
- [ ] PiKVM / NanoKVM / JetKVM backends

## Status

🚧 **Early development.** The design is settled and the code is being written. Nothing here is ready to
point at a machine whose data you care about yet. Watch the repo to follow along.

<div align="center">
<sub>Part of a family of agent toolkits that bring AI to places it couldn't reach before.</sub>
</div>

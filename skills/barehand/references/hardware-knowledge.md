# Hardware knowledge: identify, fetch, cite

Vendor-specific facts (setup keys, header pinouts, debug-LED meanings, CMOS jumper location, which M.2 slot
disables which SATA ports, supported RAM) differ per model and BIOS revision. Look them up.

## 1. Identify

In order of preference:

1. `hw_identify` (needs the rescue shell): DMI vendor/product/board, BIOS version/date, UEFI/Secure Boot, disks, GPU.
2. BIOS setup main page: board model, BIOS version, CPU, RAM.
3. POST/splash screen text.
4. Ask the human: sticker under the laptop, model printed on the board between the PCIe slots, service tag.

Record exact strings, e.g. `ASUSTeK COMPUTER INC. · PRIME B450M-A II · BIOS 3211 (2023-05-10)`.

## 2. Find the documents

Search the web (your own search tool) on the **vendor's support site** with the exact model:

| Need | Look for |
|---|---|
| Desktop motherboard | "user manual" PDF (support → manual & document) |
| Laptop / OEM desktop | "maintenance manual", "service manual", "hardware maintenance manual" (Lenovo HMM, Dell Owner's/Service Manual, HP Maintenance and Service Guide) |
| Error codes | the manual's "Debug LED"/"Q-Code"/"POST code" table; OEM "beep codes"/"diagnostic LED" pages |
| BIOS options | the "BIOS manual" or the BIOS chapter of the user manual |

Prefer vendor domains over mirrors. Then:

```
manual_fetch { url, title: "ASUS PRIME B450M-A II user manual", id: "asus-b450m-a-ii", tags: ["motherboard","asus"] }
```

Manuals persist in the local library: check `manual_list` before searching the web again.

## 3. Use them

```
manual_search { query: "front panel header PWR_SW", manual: "asus-b450m-a-ii" }
manual_read   { manual: "asus-b450m-a-ii", pages: [27, 28] }
```

- Search with the manual's vocabulary: "F_PANEL", "system panel connector", "Q-LED", "CLRTC", "CMOS",
  "DIMM installation", "M.2 SATA mode", "BIOS FlashBack".
- **Cite the page** when you tell the user something from a manual ("p. 28: the CPU LED stays lit…").
- If the manual doesn't cover it, say so instead of filling in from memory.

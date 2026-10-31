# BIOS / UEFI navigation

## Getting in

Use `key_spam_until_change` and start the boot from the same call:

```
key_spam_until_change { key: "del", before: "reset" }        # or before: "power_on" when off
```

Common keys (always confirm on the POST screen or in the manual):

| Vendor | Setup | Boot menu |
|---|---|---|
| ASUS, MSI, Gigabyte, ASRock (desktop boards) | `del` (also `f2`) | `f8` ASUS, `f11` MSI/ASRock, `f12` Gigabyte |
| Dell | `f2` | `f12` |
| HP | `esc` then `f10` | `esc` then `f9` |
| Lenovo ThinkPad | `f1` (or Enter, then F1) | `f12` (Enter, then F12) |
| Lenovo IdeaPad/Legion | `f2` (Fn+F2) or the Novo button | `f12` |
| Acer | `f2` | `f12` (may need enabling in setup) |
| Microsoft Surface | hold Volume Up while powering on | hold Volume Down |
| QEMU/OVMF lab | `esc` | `esc`, then Boot Manager |

**Fast Boot / Windows Fast Startup** can skip the hotkey window entirely. Alternatives:
- From a running Windows: `shutdown /r /fw /t 0` reboots straight into UEFI setup.
- From Linux: `systemctl reboot --firmware-setup`.
- Hold the key from before power-on with `key_hold` (some boards prefer that to repeated taps).

`key_spam_until_change` returns the first *stable new* screen. Check that it is setup, not the OS starting.

## Moving around

- Prefer the **keyboard**: arrows, Enter, Esc, Tab, `+`/`-` or PgUp/PgDn to change values, F7 for "Advanced
  mode" on ASUS/MSI, F10 to save and exit. Absolute mouse pointers often don't work in setup.
- After each few keys, capture and confirm where the highlight is. Setup menus wrap around and some skip
  greyed-out items.
- Don't change settings you weren't asked to change. Note every original value before changing it.

## Common tasks

| Task | Where it usually is |
|---|---|
| Boot order | Boot → Boot Option Priorities / Boot Sequence |
| One-time boot | Boot menu key, or "Boot Override" at the bottom of the Save & Exit page |
| Secure Boot | Boot/Security → Secure Boot (may require "OS Type: Other OS" or clearing keys) |
| CSM / Legacy boot | Boot → CSM (modern installs: keep it **off**, UEFI only) |
| Virtualization | Advanced → CPU → Intel VT-x / AMD SVM |
| SATA mode | Advanced → Storage: AHCI vs RAID/RST (Linux needs AHCI on many Intel laptops; switching under an installed Windows needs care) |
| Network boot (PXE) | Advanced → Network Stack / Onboard LAN Boot ROM; then it appears in the boot order |

Switching AHCI ↔ RAID or toggling CSM on an installed system can make it unbootable. Explain the risk first.

## Leaving

Save & Exit (usually **F10** then confirm with Enter). Watch the next boot with `screen_wait`.

## Doing it from the OS instead (often more reliable)

```
efibootmgr -v                 # list entries and order
efibootmgr -o 0003,0001       # set order (non-destructive)
efibootmgr -n 0003            # boot 0003 once
```

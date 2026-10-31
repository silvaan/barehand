# Network boot

barehand boots the target from ISOs on the controller over the network: no USB stick, no virtual-media
hardware, nothing to configure on the router. Everything (proxyDHCP, TFTP, HTTP, the iPXE menu) is built in.

```
target firmware ──PXE──► proxyDHCP (barehand)  "boot ipxe.efi from me"   ┐ the router's DHCP still hands
                ──TFTP─► ipxe.efi / undionly.kpxe                          ┘ out the IP address
iPXE            ──HTTP─► /boot.ipxe            menu: your ISOs · netboot.xyz · local disk
                ──HTTP─► /img/<iso>/…/vmlinuz, initrd, rootfs   (read straight out of the ISO)
```

## Using it

```
iso_download   { url, sha256sums_url }                 # lands in ~/.cache/barehand/images/
iso_list       {}                                      # which ISOs can be network-booted, and how
netboot_start  { isos: ["systemrescue-11.02-amd64.iso"], default: "systemrescue-11.02-amd64.iso" }
# … boot the target from the network (boot menu → "PXE" / "UEFI IPv4" / "Network")
netboot_status {}                                      # DHCP → TFTP → menu → kernel → rootfs
netboot_stop   {}
```

The menu boots `default` after `timeout_s` (5 s), so usually no key presses are needed in iPXE.

## Supported images

The ISO's distribution is detected from its file layout and booted with that distribution's own
"fetch the root filesystem over HTTP" parameter:

| Image | Recipe | Target RAM |
|---|---|---|
| SystemRescue | `archiso_http_srv=` (rescue shell, no password) | 2 GB |
| Arch Linux | `archiso_http_srv=` | 2 GB |
| Ubuntu (desktop/server live) | casper `url=` (downloads the whole ISO into RAM) | 8 GB |
| Debian live | live-boot `fetch=` | 4 GB |
| Fedora / RHEL installer | `inst.repo=` | 3 GB |
| Fedora live | dracut `root=live:` | 6 GB |
| Windows Setup / WinPE | [wimboot](https://ipxe.org/wimboot) (repair console; full install needs SMB, not yet automated) | 2 GB |
| anything else | pick it from **netboot.xyz** in the menu (target needs internet) | — |

Kernel console arguments are added automatically so `shell_exec` works after boot: `console=ttyS0` in the
lab, and a getty on `ttyACM0` (the ESP32's USB serial) on DIY hardware.

## Requirements and gotchas

- **Wired network.** The target must be on the same L2 network as the controller (same switch/router), or
  on a direct cable. PXE over Wi-Fi practically doesn't exist. A USB-Ethernet adapter works on some laptops.
  Otherwise use a Ventoy stick.
- **Privileged ports.** proxyDHCP and TFTP listen on UDP 67 and 69. On Linux/macOS, allow Node once:
  `sudo setcap cap_net_bind_service=+ep "$(readlink -f "$(which node)")"` (or run as root).
  On Windows, allow the firewall prompt.
- **WSL2** (default NAT networking) can't see LAN broadcasts: run barehand natively on Windows, or enable
  `networkingMode=mirrored`.
- **Network boot must be enabled** in the target's BIOS ("Network Stack", "PXE OPROM", "LAN Boot ROM").
  barehand can do that through the keyboard (see the bios-navigation playbook).
- **Secure Boot:** iPXE isn't signed for Secure Boot. Turn it off for the network boot and back on afterwards
  if the installed OS supports it.
- **Other PXE servers** on the same LAN (another dnsmasq, WDS, a NAS) compete with barehand. Stop them
  during the job, or use a direct cable.
- **Stop the server when done** (`netboot_stop`), so other machines that netboot don't pick it up.
- Binaries are fetched on first use: iPXE from boot.ipxe.org, netboot.xyz (SHA-256 verified) and wimboot
  from GitHub releases. Cached in `~/.cache/barehand/netboot/assets/`.

## Lab

```bash
# in the agent: netboot_start { isos: ["systemrescue.iso"] }      (mode auto → lab for the qemu backend)
lab/run-target.sh --netboot --vnc :1
```

QEMU's own user-mode DHCP/TFTP hands the VM `ipxe.efi` from barehand's TFTP folder. iPXE then runs
`autoexec.ipxe` from that same folder, which chains to barehand's HTTP menu at `10.0.2.2` (the host as seen
from the VM). No privileges are needed.

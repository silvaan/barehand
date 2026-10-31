#!/usr/bin/env bash
# Start a disposable UEFI target VM wired the way barehand's qemu backend expects:
#   QMP           -> $STATE/qmp.sock      (screen, keyboard, mouse, power, media)
#   serial (ttyS0) -> $STATE/serial.sock  (console for shell_exec)
#   CD-ROM        -> qdev id "cd0"        (media_attach / media_eject)
#   NVMe disk     -> serial BH-LAB-0001   (stable identity for destructive-op checks)
#
#   --netboot     -> boots from the network first, via barehand's netboot server (netboot_start, lab mode)
#
# Usage: lab/run-target.sh [--iso FILE] [--netboot] [--disk-size 40G] [--mem 4G] [--cpus 2] [--fresh] [--vnc :1] [--legacy]
set -euo pipefail

WORKDIR="${BAREHAND_WORKDIR:-$HOME/.cache/barehand}"
STATE="$WORKDIR/lab"
NETBOOT=0
NETBOOT_PORT="${BAREHAND_NETBOOT_PORT:-8067}"
ISO=""
DISK_SIZE="40G"
MEM="4G"
CPUS="2"
FRESH=0
VNC=""
LEGACY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --iso) ISO="$(realpath "$2")"; shift 2 ;;
    --disk-size) DISK_SIZE="$2"; shift 2 ;;
    --mem) MEM="$2"; shift 2 ;;
    --cpus) CPUS="$2"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --vnc) VNC="$2"; shift 2 ;;
    --legacy) LEGACY=1; shift ;;
    --netboot) NETBOOT=1; shift ;;
    -h|--help) sed -n 2,12p "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v qemu-system-x86_64 >/dev/null || {
  echo "qemu-system-x86_64 not found. Debian/Ubuntu: sudo apt install qemu-system-x86 qemu-utils ovmf" >&2
  exit 1
}

mkdir -p "$STATE"
if [[ $FRESH -eq 1 ]]; then rm -f "$STATE/disk.qcow2" "$STATE/OVMF_VARS.fd"; fi
[[ -f "$STATE/disk.qcow2" ]] || qemu-img create -q -f qcow2 "$STATE/disk.qcow2" "$DISK_SIZE"
rm -f "$STATE/qmp.sock" "$STATE/serial.sock"

FIRMWARE=()
if [[ $LEGACY -eq 0 ]]; then
  CODE=""; VARS=""
  for pair in \
    "/usr/share/OVMF/OVMF_CODE_4M.fd:/usr/share/OVMF/OVMF_VARS_4M.fd" \
    "/usr/share/OVMF/OVMF_CODE.fd:/usr/share/OVMF/OVMF_VARS.fd" \
    "/usr/share/edk2/x64/OVMF_CODE.4m.fd:/usr/share/edk2/x64/OVMF_VARS.4m.fd" \
    "/usr/share/edk2/ovmf/OVMF_CODE.fd:/usr/share/edk2/ovmf/OVMF_VARS.fd" \
    "/opt/homebrew/share/qemu/edk2-x86_64-code.fd:/opt/homebrew/share/qemu/edk2-i386-vars.fd" \
    "/usr/local/share/qemu/edk2-x86_64-code.fd:/usr/local/share/qemu/edk2-i386-vars.fd"; do
    c="${pair%%:*}"; v="${pair##*:}"
    if [[ -f "$c" && -f "$v" ]]; then CODE="$c"; VARS="$v"; break; fi
  done
  [[ -n "$CODE" ]] || { echo "OVMF (UEFI firmware) not found; install ovmf/edk2-ovmf or pass --legacy" >&2; exit 1; }
  [[ -f "$STATE/OVMF_VARS.fd" ]] || cp "$VARS" "$STATE/OVMF_VARS.fd"
  FIRMWARE=(
    -drive "if=pflash,format=raw,readonly=on,file=$CODE"
    -drive "if=pflash,format=raw,file=$STATE/OVMF_VARS.fd"
  )
fi

ACCEL=(-machine q35)
if [[ -w /dev/kvm ]]; then ACCEL=(-machine q35,accel=kvm -cpu host); fi

CDROM_FILE=""
[[ -n "$ISO" ]] && CDROM_FILE=",file=$ISO"

# Network: plain NAT, or NAT whose built-in DHCP/TFTP hands out barehand's iPXE.
NET_ARGS=(-nic user,model=e1000)
if [[ $NETBOOT -eq 1 ]]; then
  TFTP_DIR="$WORKDIR/netboot/tftp"
  [[ -f "$TFTP_DIR/ipxe.efi" ]] || echo "warning: $TFTP_DIR is empty; call netboot_start (lab mode) first" >&2
  if [[ $LEGACY -eq 1 ]]; then
    # QEMU's legacy NIC ROM is already iPXE: point it straight at the menu.
    BOOTFILE="http://10.0.2.2:$NETBOOT_PORT/boot.ipxe"
  else
    # UEFI PXE loads ipxe.efi over TFTP; iPXE then runs autoexec.ipxe from the same place.
    BOOTFILE="ipxe.efi"
  fi
  NET_ARGS=(-netdev "user,id=n0,tftp=$TFTP_DIR,bootfile=$BOOTFILE" -device "e1000,netdev=n0,bootindex=0")
fi

DISPLAY_ARGS=(-display none)
[[ -n "$VNC" ]] && DISPLAY_ARGS=(-display none -vnc "$VNC")

echo "barehand lab target"
echo "  state:  $STATE"
echo "  qmp:    $STATE/qmp.sock"
echo "  serial: $STATE/serial.sock"
[[ -n "$VNC" ]] && echo "  watch:  vncviewer localhost$VNC"
[[ $NETBOOT -eq 1 ]] && echo "  boot:   network first ($BOOTFILE)"
echo

exec qemu-system-x86_64 \
  "${ACCEL[@]}" -smp "$CPUS" -m "$MEM" \
  "${FIRMWARE[@]}" \
  -no-shutdown \
  -qmp "unix:$STATE/qmp.sock,server=on,wait=off" \
  -chardev "socket,id=ser0,path=$STATE/serial.sock,server=on,wait=off" \
  -serial chardev:ser0 \
  -drive "if=none,id=cdrom,media=cdrom,readonly=on$CDROM_FILE" \
  -device "ide-cd,drive=cdrom,id=cd0,bootindex=1" \
  -drive "if=none,id=disk0,format=qcow2,file=$STATE/disk.qcow2" \
  -device "nvme,drive=disk0,serial=BH-LAB-0001,bootindex=2" \
  -device qemu-xhci -device usb-tablet \
  "${NET_ARGS[@]}" \
  -vga std \
  "${DISPLAY_ARGS[@]}"

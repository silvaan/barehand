# TODO

## Friction found by the lab evals (2026-10-31)

Four blind agents fixed all four [lab scenarios](lab/scenarios/README.md) (4/4 PASS). Their reports pointed at these
rough edges in barehand itself. After fixing them, rerun the scenarios and compare time, tool calls and screenshots
with the first round (in the README's "Lab results").

### Essentials (all four agents hit these)

- [ ] **Docs: network boot from a running machine.** `netboot_start` (lab mode) and `skills/barehand/references/rescue-and-media.md`
      say to restart the VM with `lab/run-target.sh --netboot`. Agents can't do that. Document the path that works on
      both the lab and real PCs: firmware boot menu (OVMF: Esc → Boot Manager → "UEFI PXEv4"). Fix the tool's note
      too, and the "HTTP only" wording that made agents think PXE wouldn't work in lab mode.
- [ ] **Console cursor.**
  - [ ] `console_read { since: "now" }` (or `-1`) to wait only for new output.
  - [ ] `power_press` / `power_reset` (and `console_send`, which already does) return the console cursor from before the action.
  - [ ] `console_read { until }` returns the line that matched, not just `matched: true` plus a truncated buffer.
  - [ ] Document the `max_bytes` minimum (256), or drop it.
- [ ] **`console_send` pacing.** GRUB drops input after about 3 lines when several commands go in one call. Add
      `line_delay_ms` (or wait-for-prompt per line).
- [ ] **Netboot menu default.** One agent saw `choose --default img-systemrescue` while the item was
      `img-systemrescue-13.02-amd64`. It worked only because the image was first in the list. Verify, and fix if real.

### Next

- [ ] **`power_wait { state: "off" | "on", timeout_s }`.** Agents polled `power_state` in shell loops.
- [ ] **`key_spam_until_change` false negative.** It returned `reached: false` after 60 s while the screen was already
      in OVMF setup (2 agents). The baseline is probably the OVMF splash, or the change is missed during POST flicker.
      Reproduce in the lab first.
- [ ] **Skill gaps** (`skills/barehand/references/boot-repair.md` and friends):
  - [ ] Debian row uses `--bootloader-id=ubuntu`; add Debian's `debian` and `--force-extra-removable` for an emptied ESP.
  - [ ] Case "ESP emptied, no NVRAM entry".
  - [ ] Tearing down a chroot: `umount -R` fails on `/run/user/0` and cgroups; use `umount -R -l` or `--make-rslave`.
  - [ ] DNS inside a chroot when `resolv.conf` is a systemd-resolved symlink.
  - [ ] Missing kernel/initrd: `apt-get install --reinstall linux-image-…`.
  - [ ] Faster route when GRUB is on the serial line: `ls`/`cat`/`probe` at `grub>`, boot by hand, `init=/bin/bash`
        for a root shell when there are no credentials for the installed OS.
  - [ ] Emergency mode is useless when root is locked (Debian/Ubuntu default): go straight to the rescue route.
  - [ ] A black or garbled screen while the OS is up means "use the serial console", not a capture problem.
- [ ] **Screen size changes** (1024×768 at GRUB, 800×600 later): say so in the capture result, since mouse
      coordinates depend on it.

### Lab housekeeping

- [ ] **Base image: generate SSH host keys.** `ssh.service` fails on every boot, so three agents spent time on it.
      Add `ssh-keygen -A` in the chroot to `BASE` in `lab/scenarios/scenarios.mjs`, then rebuild (`rm` base + `prepare`).
- [ ] **Call helper quoting.** `call.sh` takes raw JSON, so `\;`, `\"` and `$` need double escaping. Read the JSON
      from stdin or a file, or document it in `agent-brief.md`.

## Roadmap

See [README › Roadmap](README.md#roadmap).

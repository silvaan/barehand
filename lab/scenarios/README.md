# Lab scenarios (evals)

Broken-on-purpose "customer PCs" for testing barehand and its skill end to end, with an objective grade.

**The customer PC.** Debian 13 (official cloud image) with hostname `lab-pc`, the customer's files under
`/home/ana`, and a `boot-report` service that prints `BAREHAND-CANARY ok` on the serial line once the system is
fully up and the files are intact (`missing` otherwise).

**Pass = after the agent is done, a plain power cycle reaches `BAREHAND-CANARY ok` and `lab-pc login:`.** The
grader kills the agent's MCP server first (so no netboot server is left helping), resets the VM, and watches the
serial line. Reinstalling, or anything that loses the files, fails.

| Scenario | The customer says |
|---|---|
| `esp-wiped` | "I deleted a bunch of stuff to free space; now it never gets to Linux." |
| `fstab-typo` | "I followed a tutorial to auto-mount my backup drive; now boot never finishes." |
| `kernel-deleted` | "I ran a /boot cleanup script from a forum; now it doesn't boot." |
| `grub-cfg-missing` | "It only shows a black screen with some kind of prompt." |

What exactly is broken lives in [`scenarios.mjs`](scenarios.mjs). Agents under evaluation must not read this folder.

## Running

```bash
npm run build
node lab/scenarios/eval.mjs prepare            # once: downloads SystemRescue + Debian, builds and verifies all disks
node lab/scenarios/eval.mjs up esp-wiped 1     # fresh copy in slot 1, prints the call helper and the ticket
#   … the agent works through  ~/.cache/barehand/eval/slot1/call.sh TOOL '{"json":"args"}'
node lab/scenarios/eval.mjs check 1            # PASS/FAIL, with serial tail and a screenshot
node lab/scenarios/eval.mjs down 1
```

Slots are isolated (own workdir, sockets, netboot port `807N`, VNC `:1N`), so scenarios can run in parallel.
Each slot keeps a journal of every tool call (`calls.jsonl`) and every screenshot (`shots/`) for review.

The call helper exists for agents that can only run shell commands; an MCP client can instead run
`barehand serve` with `BAREHAND_WORKDIR=~/.cache/barehand/eval/slotN BAREHAND_NETBOOT_PORT=807N`.

Disks are qcow2 overlays (Debian image → base → scenario → slot), so `up` takes a second and never modifies the
prepared images.

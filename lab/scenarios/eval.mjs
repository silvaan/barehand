#!/usr/bin/env node
// Lab scenarios: build broken-on-purpose "customer PCs", hand them to an agent, and grade the result.
//
//   node lab/scenarios/eval.mjs prepare              build base + every scenario disk, and verify each one is broken
//   node lab/scenarios/eval.mjs up <scenario> <slot> start a fresh copy of a scenario in a slot, with an HTTP driver
//   node lab/scenarios/eval.mjs check <slot>         stop the agent's server, power-cycle, PASS/FAIL
//   node lab/scenarios/eval.mjs down <slot>          stop everything in a slot
//   node lab/scenarios/eval.mjs list
//
// Slot N: VNC :1N, netboot HTTP 807N, driver 781N, files under ~/.cache/barehand/eval/slotN/.
import fs from "node:fs";
import path from "node:path";
import {
  DEBIAN_SUMS, DEBIAN_URL, IMAGES, ISO_DIR, REPO, RESCUE_ISO, RESCUE_ISO_URL,
  lastJson, log, mcp, overlay, prepareSlotDir, sleep, slot, startProc, startVm, stopProc,
} from "./lib.mjs";
import { BASE, MOUNT, SCENARIOS, UMOUNT, scenario } from "./scenarios.mjs";

const DEBIAN = path.join(IMAGES, "debian-13-genericcloud-amd64.qcow2");
const BASE_DISK = path.join(IMAGES, "base.qcow2");
const scenDisk = (name) => path.join(IMAGES, `scenario-${name}.qcow2`);

const VERDICT =
  /BAREHAND-CANARY (ok|missing)|You are in emergency mode|root account is locked|Kernel panic[^\n]*|sysrescue login|error: file [^\n]*not found|you need to load the kernel first|Gave up waiting[^\n]*|\(initramfs\)/;

async function fetchInputs() {
  const { download } = await import(path.join(REPO, "dist", "download.js"));
  if (!fs.existsSync(path.join(ISO_DIR, RESCUE_ISO))) {
    log("downloading", RESCUE_ISO);
    await download(RESCUE_ISO_URL, ISO_DIR, { sha256SumsUrl: `${RESCUE_ISO_URL}.sha256` });
  }
  if (!fs.existsSync(DEBIAN)) {
    log("downloading Debian 13 cloud image");
    const sums = await (await fetch(DEBIAN_SUMS)).text();
    const line = sums.split("\n").find((l) => l.endsWith(" debian-13-genericcloud-amd64.qcow2"));
    if (!line) throw new Error("Debian SHA512SUMS has no genericcloud qcow2 entry");
    const res = await fetch(DEBIAN_URL);
    if (!res.ok) throw new Error(`Debian image: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { createHash } = await import("node:crypto");
    if (createHash("sha512").update(buf).digest("hex") !== line.split(/\s+/)[0]) throw new Error("Debian image checksum mismatch");
    fs.mkdirSync(IMAGES, { recursive: true });
    fs.writeFileSync(DEBIAN, buf);
  }
}

/** Boot SystemRescue over the network in slot s (on `disk`) and run `script` in it, then power off. */
async function inRescue(s, disk, script, plan) {
  prepareSlotDir(s);
  const m = await mcp(s);
  try {
    await m.call("netboot_start", { isos: [RESCUE_ISO], default: RESCUE_ISO });
    await startVm(s, { disk, netboot: "first" });
    const r = await m.call("console_read", { until: "automatic login", wait_ms: 600_000, max_bytes: 2000 });
    if (!lastJson(r.text)?.matched) throw new Error(`slot ${s.n}: SystemRescue did not come up:\n${r.text}`);
    await sleep(3000);
    const cmd = `( ${MOUNT}\n${script}\n${UMOUNT} ) 2>&1; echo "rc=$?"`;
    let out;
    try {
      out = await m.call("shell_exec", { command: cmd, timeout_s: 600 });
    } catch (e) {
      if (!/Refused/.test(e.message)) throw e;
      out = await m.call("shell_exec_destructive", { command: cmd, plan, timeout_s: 600 });
    }
    if (!/rc=0/.test(out.text)) throw new Error(`slot ${s.n}: script failed:\n${out.text}`);
  } finally {
    await m.close().catch(() => {});
    await stopProc(s, "vm");
  }
}

/** Power-cycle the target with no netboot server and no help, and see whether the customer's system comes up. */
async function check(s, { waitMin = 10 } = {}) {
  await stopProc(s, "driver"); // the agent's MCP server goes away, and with it any netboot server it started
  const m = await mcp(s);
  const t0 = Date.now();
  try {
    const st = lastJson((await m.call("session_status")).text);
    const since = st?.console_cursor ?? 0;
    if (st?.power === "off") await m.call("power_press");
    else await m.call("power_reset");
    const r = await m.call("console_read", { since, until: VERDICT.source, wait_ms: waitMin * 60_000, max_bytes: 200_000 });
    const hit = r.text.match(VERDICT);
    let verdict = hit ? hit[0] : `timeout after ${waitMin} min (no canary on the serial line)`;
    let pass = hit?.[1] === "ok";
    if (pass) {
      const l = await m.call("console_read", { since, until: "lab-pc login:", wait_ms: 180_000, max_bytes: 200_000 });
      if (!lastJson(l.text)?.matched) {
        pass = false;
        verdict += ", but no lab-pc login prompt";
      }
    }
    const shot = (await m.call("screen_capture")).images[0];
    const shotFile = path.join(s.dir, `check-${Date.now()}.png`);
    if (shot) fs.writeFileSync(shotFile, shot);
    const tail = r.text.split("\n").slice(-12).join("\n");
    return { pass, verdict, seconds: Math.round((Date.now() - t0) / 1000), screenshot: shotFile, serial_tail: tail };
  } finally {
    await m.close().catch(() => {});
  }
}

async function up(name, n) {
  const sc = scenario(name);
  const s = slot(n);
  await stopProc(s, "driver");
  await stopProc(s, "vm");
  fs.rmSync(s.dir, { recursive: true, force: true });
  prepareSlotDir(s);
  if (!fs.existsSync(scenDisk(name))) throw new Error(`no disk for ${name}; run prepare first`);
  await overlay(scenDisk(name), s.disk);
  await startVm(s, { disk: s.disk, netboot: "fallback" });
  const call = path.join(s.dir, "call.sh");
  fs.writeFileSync(
    call,
    `#!/usr/bin/env bash\n# usage: ${call} TOOL ['{"json":"args"}']\nprintf '{"name":"%s","arguments":%s}' "$1" "\${2:-{\\}}" | curl -s -X POST --data-binary @- 127.0.0.1:${s.driverPort}\n`,
    { mode: 0o755 },
  );
  startProc(s, "driver", process.execPath, [path.join(REPO, "lab", "scenarios", "driver.mjs"), String(n)]);
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${s.driverPort}`, { method: "POST", body: '{"name":"__describe"}' });
      break;
    } catch {
      await sleep(200);
    }
  }
  fs.writeFileSync(path.join(s.dir, "scenario.json"), JSON.stringify({ name, started: new Date().toISOString() }));
  return { scenario: name, slot: n, call, vnc: `localhost${s.vnc}`, ticket: sc.ticket, dir: s.dir };
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "list") {
    for (const sc of SCENARIOS) console.log(`${sc.name.padEnd(18)} ${fs.existsSync(scenDisk(sc.name)) ? "ready " : "      "} ${sc.ticket}`);
  } else if (cmd === "prepare") {
    await fetchInputs();
    const only = rest.length ? rest : SCENARIOS.map((x) => x.name);
    if (!fs.existsSync(BASE_DISK)) {
      log("building base (Debian 13 + customer files + boot report)");
      const tmp = `${BASE_DISK}.tmp`;
      fs.rmSync(tmp, { force: true });
      await overlay(DEBIAN, tmp, "8G");
      await inRescue(slot(0), tmp, BASE, "lab: customize the base image");
      fs.renameSync(tmp, BASE_DISK);
      fs.rmSync(`${BASE_DISK}.ok`, { force: true });
    }
    if (!fs.existsSync(`${BASE_DISK}.ok`)) {
      log("smoke test: the base must boot and report its files intact");
      const s0 = slot(0);
      fs.rmSync(s0.disk, { force: true });
      await overlay(BASE_DISK, s0.disk);
      await startVm(s0, { disk: s0.disk, netboot: "fallback" });
      const r = await check(s0);
      await stopProc(s0, "vm");
      log("base:", r.pass ? "PASS" : "FAIL", r.verdict, `${r.seconds}s`);
      if (!r.pass) throw new Error(`the unbroken base does not pass the check:\n${r.serial_tail}`);
      fs.writeFileSync(`${BASE_DISK}.ok`, new Date().toISOString());
    }
    const results = await Promise.all(
      only.map(async (name, i) => {
        const sc = scenario(name);
        const s = slot(i + 1);
        const disk = scenDisk(name);
        log(`${name}: breaking (slot ${s.n})`);
        const tmp = `${disk}.tmp`;
        fs.rmSync(tmp, { force: true });
        await overlay(BASE_DISK, tmp);
        await inRescue(s, tmp, sc.break, `lab: break scenario ${name}`);
        fs.renameSync(tmp, disk);
        log(`${name}: verifying it is actually broken`);
        fs.rmSync(s.disk, { force: true });
        await overlay(disk, s.disk);
        await startVm(s, { disk: s.disk, netboot: "fallback" });
        const r = await check(s, { waitMin: 6 });
        await stopProc(s, "vm");
        log(`${name}: ${r.pass ? "NOT BROKEN (bad scenario)" : "broken as intended"}: ${r.verdict}`);
        return { name, broken: !r.pass, symptom: r.verdict, screenshot: r.screenshot };
      }),
    );
    console.log(JSON.stringify(results, null, 2));
  } else if (cmd === "up") {
    console.log(JSON.stringify(await up(rest[0], Number(rest[1] ?? 1)), null, 2));
  } else if (cmd === "check") {
    const s = slot(Number(rest[0] ?? 1));
    const r = await check(s);
    fs.writeFileSync(path.join(s.dir, "result.json"), JSON.stringify(r, null, 2));
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === "down") {
    const s = slot(Number(rest[0] ?? 1));
    await stopProc(s, "driver");
    await stopProc(s, "vm");
  } else {
    console.error("usage: eval.mjs prepare [scenario…] | up <scenario> <slot> | check <slot> | down <slot> | list");
    process.exit(2);
  }
  process.exit(0);
} catch (e) {
  console.error("error:", e.message);
  process.exit(1);
}

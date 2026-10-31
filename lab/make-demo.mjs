#!/usr/bin/env node
// Turn a recorded lab run into a short demo video + GIF: the target's screen on the left, the agent's barehand
// tool calls on the right, sped up so screen changes and tool calls stay readable.
//
//   node lab/make-demo.mjs --frames DIR --calls calls.jsonl --out docs/media/demo [--result result.json]
//                          [--title "..."] [--seconds 36]
//
// Frames come from lab/record-vnc.mjs (<epoch-ms>.png). Writes <out>.mp4 and <out>.gif.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { thumbOfPng, thumbDiff } = await import(path.join(REPO, "dist", "util", "frames.js"));

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
if (!args.frames || !args.calls || !args.out) {
  console.error("usage: make-demo.mjs --frames DIR --calls calls.jsonl --out PATH [--result result.json] [--title T] [--seconds 36]");
  process.exit(2);
}
const TARGET_S = Number(args.seconds ?? 36);
const TITLE = args.title ?? "barehand: Claude fixes a PC that won't boot";
const MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf";
const MONO_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf";
const SANS_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const W = 1280, H = 720, SW = 800, SH = 600, SX = 24, SY = 84, PX = 848;

// ---- inputs -------------------------------------------------------------------------------------------------
const frames = fs
  .readdirSync(args.frames)
  .filter((f) => /^\d+\.png$/.test(f))
  .map((f) => ({ t: Number(f.slice(0, -4)), file: path.join(args.frames, f) }))
  .sort((a, b) => a.t - b.t);
if (!frames.length) throw new Error("no frames");

const calls = fs
  .readFileSync(args.calls, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((c) => !c.name.startsWith("__"))
  .map((c) => ({ ...c, end: Date.parse(c.t), start: Date.parse(c.t) - c.ms }));
const result = args.result && fs.existsSync(args.result) ? JSON.parse(fs.readFileSync(args.result, "utf8")) : undefined;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
function describe(c) {
  const a = c.args ?? {};
  switch (c.name) {
    case "shell_exec":
    case "shell_exec_destructive": {
      const cmd = String(a.command ?? "").split("\n").filter(Boolean);
      const first = `$ ${cmd[0] ?? ""}${cmd.length > 1 ? " …" : ""}`;
      const code = /"exit_code":\s*(-?\d+|null)/.exec(c.out)?.[1];
      const out = c.out.replace(/\{[\s\S]*$/, "").trim().split("\n").filter(Boolean).slice(0, 4);
      return {
        head: c.name === "shell_exec_destructive" ? "shell_exec_destructive  (plan approved)" : "shell_exec",
        body: [first, ...out.map((l) => `  ${l}`), ...(code !== undefined ? [`  → exit ${code}`] : [])],
        hold: 1.6,
      };
    }
    case "console_read":
      return { head: "console_read", body: [a.until ? `wait for "${a.until}"` : "read serial console"], hold: 0.9 };
    case "console_send":
      return { head: "console_send", body: [JSON.stringify(a.data ?? "")], hold: 0.8 };
    case "netboot_start":
      return { head: "netboot_start", body: [`PXE + iPXE menu → ${(a.default ?? a.isos?.[0] ?? "").replace(/\.iso$/, "")}`], hold: 1.2 };
    case "netboot_status":
      return { head: "netboot_status", body: c.out.match(/"what": "([^"]+)"/g)?.slice(-3).map((m) => m.slice(9, -1)) ?? [], hold: 1.0 };
    case "netboot_stop":
      return { head: "netboot_stop", body: [], hold: 0.6 };
    case "key_press":
    case "key_spam_until_change":
      return { head: c.name, body: [JSON.stringify(a.keys ?? a.key ?? "")], hold: 0.7 };
    case "type_text":
      return { head: "type_text", body: [JSON.stringify(clip(String(a.text ?? ""), 50))], hold: 0.8 };
    case "screen_capture":
    case "screen_wait":
      return { head: c.name, body: ["(looks at the screen)"], hold: 0.6 };
    default: {
      const s = JSON.stringify(a);
      return { head: c.name, body: s === "{}" ? [] : [clip(s, 54)], hold: 0.7 };
    }
  }
}

function phase(t) {
  const before = calls.filter((c) => c.start <= t);
  const names = before.map((c) => c.name);
  const lastShell = calls.filter((c) => /^shell_exec/.test(c.name)).at(-1);
  const lastPower = before.filter((c) => /^power_|reboot/.test(c.name) || /reboot/.test(c.args?.command ?? "")).at(-1);
  if (lastShell && lastPower && lastPower.start >= lastShell.start) return "4 · reboot into the repaired system";
  if (names.some((n) => /^shell_exec/.test(n))) return "3 · repair over the serial shell";
  if (names.includes("netboot_start")) return "2 · boot a rescue system over the network";
  return "1 · look at the broken PC";
}

// ---- timeline -----------------------------------------------------------------------------------------------
const t0 = Math.min(frames[0].t, calls[0]?.start ?? Infinity);
const tEnd = frames.at(-1).t;
const nearest = (t) => {
  let best = frames[0];
  for (const f of frames) if (f.t <= t) best = f;
  return best;
};
const items = []; // { t, frame, hold, event? }
let lastThumb;
let lastKept = -Infinity;
for (const f of frames) {
  const th = thumbOfPng(fs.readFileSync(f.file));
  const d = lastThumb ? thumbDiff(lastThumb, th) : 1;
  if (d > 0.015 || f.t - lastKept > 25_000) {
    items.push({ t: f.t, frame: f, hold: d > 0.015 ? 0.35 : 0.2 });
    lastKept = f.t;
  }
  lastThumb = th;
}
for (const c of calls) {
  if (c.start < t0 || c.start > tEnd) continue;
  items.push({ t: c.start, frame: nearest(c.start), hold: describe(c).hold, event: c });
}
items.sort((a, b) => a.t - b.t);
const total = items.reduce((s, i) => s + i.hold, 0);
const scale = Math.min(1, (TARGET_S - 3) / total);
for (const i of items) i.hold = Math.max(0.08, i.hold * scale);
const speedup = Math.round((tEnd - t0) / 1000 / items.reduce((s, i) => s + i.hold, 0));

// ---- render -------------------------------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "barehand-demo-"));
const esc = (p) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
function render(item, idx, final = false) {
  const t = item.t;
  const done = calls.filter((c) => c.start <= t);
  const current = item.event ?? done.at(-1);
  const history = done.filter((c) => c !== current).slice(-9).map((c) => `· ${c.name}`);
  const cur = current ? describe(current) : { head: "", body: [] };
  const files = {
    hist: history.join("\n") || " ",
    head: cur.head ? `▸ ${cur.head}` : " ",
    body: cur.body.map((l) => clip(l, 50)).join("\n") || " ",
    phase: final ? "✓ boots on its own · customer files intact" : phase(t),
    title: TITLE,
    sub: `real run · QEMU lab · ${speedup}× speed`,
  };
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(tmp, `${k}.txt`), v);
  const dt = (font, file, x, y, size, color) =>
    `drawtext=fontfile=${font}:textfile='${esc(path.join(tmp, file))}':expansion=none:x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}:line_spacing=6`;
  const filter = [
    `color=c=0x0d1117:s=${W}x${H}[bg]`,
    `[0:v]scale=${SW}:${SH}:force_original_aspect_ratio=decrease,pad=${SW}:${SH}:(ow-iw)/2:(oh-ih)/2:color=black[scr]`,
    `[bg][scr]overlay=${SX}:${SY}[a]`,
    `[a]drawbox=x=${SX - 2}:y=${SY - 2}:w=${SW + 4}:h=${SH + 4}:color=0x30363d:t=2,` +
      `drawbox=x=${PX}:y=${SY - 2}:w=${W - PX - 24}:h=${SH + 4}:color=0x161b22:t=fill,` +
      [
        dt(SANS_B, "title.txt", SX, 22, 26, "white"),
        dt(MONO, "sub.txt", SX, 56, 15, "0x8b949e"),
        dt(MONO_B, "phase.txt", PX + 16, SY + 14, 17, final ? "0x3fb950" : "0x58a6ff"),
        dt(MONO, "hist.txt", PX + 16, SY + 54, 15, "0x6e7681"),
        dt(MONO_B, "head.txt", PX + 16, SY + 330, 17, "0xf0f6fc"),
        dt(MONO, "body.txt", PX + 16, SY + 362, 14, "0x7ee787"),
      ].join(",") +
      `,drawtext=fontfile=${MONO}:text='github.com/silvaan/barehand':x=${W - 290}:y=${H - 30}:fontsize=15:fontcolor=0x8b949e`,
  ].join(";");
  const out = path.join(tmp, `f${String(idx).padStart(4, "0")}.png`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", item.frame.file, "-filter_complex", filter, "-frames:v", "1", out]);
  return out;
}

const list = [];
items.forEach((it, i) => list.push(`file '${render(it, i)}'\nduration ${it.hold.toFixed(3)}`));
const finalFrame = render({ t: tEnd, frame: frames.at(-1) }, items.length, !!result?.pass);
list.push(`file '${finalFrame}'\nduration 3`, `file '${finalFrame}'`);
fs.writeFileSync(path.join(tmp, "list.txt"), list.join("\n") + "\n");

fs.mkdirSync(path.dirname(args.out), { recursive: true });
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", path.join(tmp, "list.txt"),
  "-vf", "fps=25,format=yuv420p", "-c:v", "libx264", "-crf", "23", "-preset", "slow", "-movflags", "+faststart", `${args.out}.mp4`]);
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", `${args.out}.mp4`, "-filter_complex",
  "fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
  `${args.out}.gif`]);
const size = (f) => `${(fs.statSync(f).size / 1e6).toFixed(1)} MB`;
console.log(JSON.stringify({ mp4: `${args.out}.mp4`, mp4_size: size(`${args.out}.mp4`), gif: `${args.out}.gif`, gif_size: size(`${args.out}.gif`),
  seconds: Number((items.reduce((s, i) => s + i.hold, 0) + 3).toFixed(1)), speedup, frames: items.length }));
fs.rmSync(tmp, { recursive: true, force: true });

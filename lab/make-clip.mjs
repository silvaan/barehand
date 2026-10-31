#!/usr/bin/env node
// Short, plain clip from a recorded lab run: big serial text or the real screen, the agent's latest barehand tool
// calls in a strip at the bottom, one small caption. No title cards.
//   node lab/make-clip.mjs lab/demos/fstab-typo.json docs/media/clip
//
// Storyboard (JSON): { frames: <record-vnc dir>, calls: <calls.jsonl>, segments: [...] }. Each segment has a
// `caption`, an optional `title` (bigger, e.g. the customer's ticket; `titleColor`), a `hold` in seconds, and either
//   lines: [...]   text (prefix ! red, + green, $ bright), with `at` (ISO time) to pick the tool calls shown, or
//   screen: {from, to}  recorded frames (scene changes only) squeezed into `hold`; tool calls follow each frame's time.
// Writes <out>.mp4 and <out>.gif.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { thumbOfPng, thumbDiff } = await import(path.join(REPO, "dist", "util", "frames.js"));
const [boardFile, out] = process.argv.slice(2);
if (!boardFile || !out) {
  console.error("usage: make-clip.mjs <storyboard.json> <out-path-without-extension>");
  process.exit(2);
}
const home = (p) => p.replace(/^~/, os.homedir());
const board = JSON.parse(fs.readFileSync(boardFile, "utf8"));
const calls = fs
  .readFileSync(home(board.calls), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((c) => !c.name.startsWith("__") && c.name !== "?" && !c.error)
  .map((c) => ({ ...c, start: Date.parse(c.t) - c.ms }));

const W = 1280, H = 720, MX = 60;
const STRIP_Y = H - 158, STRIP_H = 112;
const MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf";
const MONO_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf";
const SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const SANS_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const COLORS = { "!": "0xff7b72", "+": "0x7ee787", $: "0xf0f6fc" };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "barehand-clip-"));
const esc = (p) => p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
let nFile = 0;
const textFile = (s) => {
  const f = path.join(tmp, `t${nFile++}.txt`);
  fs.writeFileSync(f, s);
  return esc(f);
};
const draw = (font, text, x, y, size, color) =>
  `drawtext=fontfile=${font}:textfile='${textFile(text)}':expansion=none:x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}`;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function fmtCall(c) {
  const a = c.args ?? {};
  switch (c.name) {
    case "shell_exec":
    case "shell_exec_destructive":
      return `${c.name}  $ ${String(a.command ?? "").split("\n")[0]}`;
    case "console_read":
      return a.until ? `console_read  until "${a.until}"` : "console_read";
    case "console_send":
      return `console_send  ${JSON.stringify(a.data ?? "")}`;
    case "netboot_start":
      return `netboot_start  ${(a.isos ?? []).join(", ")}`;
    case "key_press":
      return `key_press  ${(a.keys ?? []).join(" ")}`;
    case "key_spam_until_change":
      return `key_spam_until_change  ${a.key ?? a.keys}  (from ${a.before ?? "now"})`;
    case "type_text":
      return `type_text  ${JSON.stringify(a.text ?? "")}`;
    default:
      return c.name;
  }
}

/** The tool-call strip: the agent's last three calls at time t, newest highlighted. */
function strip(t) {
  const recent = calls.filter((c) => c.start <= t).slice(-3);
  const f = [
    `drawbox=x=0:y=${STRIP_Y}:w=${W}:h=${STRIP_H}:color=0x161b22:t=fill`,
    draw(SANS, "agent → barehand  (MCP tool calls)", MX, STRIP_Y + 10, 14, "0x6e7681"),
  ];
  recent.forEach((c, i) => {
    const last = i === recent.length - 1;
    const y = STRIP_Y + 34 + (i + 3 - recent.length) * 24;
    f.push(draw(last ? MONO_B : MONO, clip(`${last ? "▸ " : "  "}${fmtCall(c)}`, 104), MX, y, 17, last ? "0xf0f6fc" : "0x6e7681"));
  });
  return f;
}

/** Caption, optional title, tool strip, footer. Returns [filters, y where the main area starts]. */
function chrome(seg, t) {
  const f = [draw(SANS, seg.caption, MX, 24, 18, "0x8b949e")];
  let y = 60;
  if (seg.title) {
    // Wrap at ~78 characters (25 px sans on a 1160 px line), keeping explicit line breaks.
    const lines = seg.title.split("\n").flatMap((para) => {
      const out = [""];
      for (const w of para.split(" ")) {
        if ((out.at(-1) + " " + w).trim().length > 78) out.push(w);
        else out[out.length - 1] = (out.at(-1) + " " + w).trim();
      }
      return out;
    });
    lines.forEach((l, i) => f.push(draw(SANS_B, l, MX, 54 + i * 34, 25, seg.titleColor ?? "0xf0f6fc")));
    y = 54 + lines.length * 34 + 14;
  }
  f.push(...strip(t), draw(SANS, "barehand · real run, sped up", `w-tw-${MX}`, H - 32, 14, "0x6e7681"));
  return [f, y];
}

let idx = 0;
const nextFile = () => path.join(tmp, `f${String(idx++).padStart(4, "0")}.png`);

function renderText(seg) {
  const [chromeF, top] = chrome(seg, Date.parse(seg.at));
  const lines = seg.lines.map((l) => (COLORS[l[0]] ? { c: COLORS[l[0]], t: l.slice(1) } : { c: "0xc9d1d9", t: l }));
  const longest = Math.max(...lines.map((l) => l.t.length), 1);
  const avail = STRIP_Y - 16 - top;
  const size = Math.min(24, Math.floor((W - 2 * MX) / (0.602 * longest)), Math.floor(avail / (lines.length * 1.5)));
  const lh = Math.round(size * 1.5);
  const y0 = top + Math.max(0, Math.round((avail - lines.length * lh) / 2));
  const filters = [...lines.flatMap((l, i) => (l.t.trim() ? [draw(MONO, l.t, MX, y0 + i * lh, size, l.c)] : [])), ...chromeF];
  const f = nextFile();
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x0d1117:s=${W}x${H}`, "-vf", `${filters.join(",")},format=rgb24`, "-frames:v", "1", f]);
  return [{ file: f, hold: seg.hold }];
}

function renderScreen(seg) {
  const dir = home(board.frames);
  const from = Date.parse(seg.screen.from), to = Date.parse(seg.screen.to);
  const frames = fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.png$/.test(f))
    .map((f) => ({ t: Number(f.slice(0, -4)), file: path.join(dir, f) }))
    .filter((f) => f.t >= from && f.t <= to)
    .sort((a, b) => a.t - b.t);
  const picked = [];
  let last;
  for (const fr of frames) {
    const th = thumbOfPng(fs.readFileSync(fr.file));
    if (!last || thumbDiff(last, th) > 0.002) picked.push(fr);
    last = th;
  }
  if (!picked.length) throw new Error(`no frames between ${seg.screen.from} and ${seg.screen.to}`);
  const hold = seg.hold / picked.length;
  return picked.map((fr) => {
    const [chromeF, top] = chrome(seg, fr.t);
    const sh = STRIP_Y - 12 - top;
    const f = nextFile();
    const filter = `color=c=0x0d1117:s=${W}x${H}[bg];[0:v]scale=-2:${sh}[s];[bg][s]overlay=(W-w)/2:${top}:shortest=1,${chromeF.join(",")},format=rgb24`;
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", fr.file, "-filter_complex", filter, "-frames:v", "1", f]);
    return { file: f, hold };
  });
}

const shots = board.segments.flatMap((s) => (s.lines ? renderText(s) : renderScreen(s)));
const list = shots.map((s) => `file '${s.file}'\nduration ${s.hold.toFixed(3)}`);
list.push(`file '${shots.at(-1).file}'`);
fs.writeFileSync(path.join(tmp, "list.txt"), list.join("\n") + "\n");
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", path.join(tmp, "list.txt"),
  "-vf", "fps=25,format=yuv420p", "-c:v", "libx264", "-crf", "20", "-preset", "slow", "-movflags", "+faststart", `${out}.mp4`]);
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", `${out}.mp4`, "-filter_complex",
  "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
  `${out}.gif`]);
const mb = (f) => `${(fs.statSync(f).size / 1e6).toFixed(1)} MB`;
const secs = shots.reduce((a, s) => a + s.hold, 0);
console.log(JSON.stringify({ mp4: `${out}.mp4`, mp4_size: mb(`${out}.mp4`), gif: `${out}.gif`, gif_size: mb(`${out}.gif`), seconds: Number(secs.toFixed(1)), shots: shots.length }));
if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true });
else console.error("kept", tmp);

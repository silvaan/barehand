#!/usr/bin/env node
// Short, plain clip from a recorded lab run: big serial text and the real screen, one small caption, no titles.
//   node lab/make-clip.mjs lab/demos/fstab-typo.json docs/media/clip
// Storyboard: segments of either `lines` (text; prefix ! red, + green, $ bright) or `screen` {from, to} (recorded
// frames from lab/record-vnc.mjs, scene changes only, squeezed into `hold` seconds). Writes <out>.mp4 and <out>.gif.
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
const board = JSON.parse(fs.readFileSync(boardFile, "utf8"));
const W = 1280, H = 720, MX = 60;
const MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf";
const SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
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

const chrome = (caption) => [
  draw(SANS, caption, MX, 34, 22, "0x8b949e"),
  draw(SANS, "barehand · real run, sped up", `w-tw-${MX}`, H - 40, 16, "0x6e7681"),
];

let idx = 0;
function renderText(seg) {
  const lines = seg.lines.map((l) => (COLORS[l[0]] ? { c: COLORS[l[0]], t: l.slice(1) } : { c: "0xc9d1d9", t: l }));
  const longest = Math.max(...lines.map((l) => l.t.length), 1);
  const size = Math.min(26, Math.floor((W - 2 * MX) / (0.602 * longest)));
  const lh = Math.round(size * 1.55);
  const top = Math.round((H - lines.length * lh) / 2) + 10;
  const filters = [
    ...chrome(seg.caption),
    ...lines.flatMap((l, i) => (l.t.trim() ? [draw(MONO, l.t, MX, top + i * lh, size, l.c)] : [])),
  ];
  const f = path.join(tmp, `f${String(idx++).padStart(4, "0")}.png`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x0d1117:s=${W}x${H}`, "-vf", `${filters.join(",")},format=rgb24`, "-frames:v", "1", f]);
  return [{ file: f, hold: seg.hold }];
}

function renderScreen(seg) {
  const dir = board.frames.replace(/^~/, os.homedir());
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
  const SH = H - 130;
  return picked.map((fr) => {
    const f = path.join(tmp, `f${String(idx++).padStart(4, "0")}.png`);
    const filter =
      `color=c=0x0d1117:s=${W}x${H}[bg];[0:v]scale=-2:${SH}[s];[bg][s]overlay=(W-w)/2:90:shortest=1,` + chrome(seg.caption).join(",") + ",format=rgb24";
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
if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true }); else console.error("kept", tmp);

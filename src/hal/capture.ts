/**
 * UVC video capture via a long-running ffmpeg process.
 *
 * ffmpeg re-encodes the capture card's stream to PNG at a low frame rate and
 * we keep only the latest frame, so `latest()` is instant and always fresh to
 * within 1/fps seconds. Works with any UVC device: HDMI capture dongles, or a
 * webcam pointed at a laptop screen.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { PngStreamSplitter } from "../util/pngstream.js";
import { pngSize } from "../util/frames.js";
import type { Frame } from "./types.js";

export interface CaptureOptions {
  /** Linux: /dev/video0 · Windows: "video=USB Video" or just the device name · macOS: "0" */
  device: string;
  /** Optional input size requested from the device, e.g. "1920x1080". */
  size?: string;
  /** Frames per second delivered to barehand (not the device rate). */
  fps?: number;
  /** Downscale wider frames to this width (keeps tokens and payload small). */
  maxWidth?: number;
  ffmpeg?: string;
}

export function ffmpegInputArgs(device: string, size?: string, platform = process.platform): string[] {
  const sizeArgs = size ? ["-video_size", size] : [];
  if (platform === "win32") {
    const dev = device.startsWith("video=") ? device : `video=${device}`;
    return ["-f", "dshow", ...sizeArgs, "-i", dev];
  }
  if (platform === "darwin") {
    return ["-f", "avfoundation", ...sizeArgs, "-framerate", "30", "-i", device];
  }
  return ["-f", "v4l2", "-input_format", "mjpeg", ...sizeArgs, "-i", device];
}

export class VideoCapture {
  private proc?: ChildProcess;
  private last?: Frame;
  private waiters: Array<(f: Frame) => void> = [];
  private stderrTail = "";

  constructor(private readonly opts: CaptureOptions) {}

  start() {
    if (this.proc) return;
    const fps = this.opts.fps ?? 4;
    const maxW = this.opts.maxWidth ?? 1280;
    const args = [
      "-hide_banner", "-loglevel", "error",
      ...ffmpegInputArgs(this.opts.device, this.opts.size),
      "-vf", `fps=${fps},scale='min(${maxW},iw)':-2`,
      "-f", "image2pipe", "-c:v", "png", "-compression_level", "1", "-",
    ];
    const proc = spawn(this.opts.ffmpeg ?? "ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    const splitter = new PngStreamSplitter((png) => {
      const { width, height } = pngSize(png);
      const frame: Frame = { png, width, height, capturedAt: Date.now() };
      this.last = frame;
      const w = this.waiters;
      this.waiters = [];
      w.forEach((fn) => fn(frame));
    });
    proc.stdout!.on("data", (d: Buffer) => splitter.push(d));
    proc.stderr!.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    proc.on("exit", () => {
      this.proc = undefined;
    });
    proc.on("error", (e) => {
      this.stderrTail += `\n${e.message}`;
      this.proc = undefined;
    });
  }

  /** Returns a frame no older than `maxAgeMs`, waiting for the next one if needed. */
  async frame(maxAgeMs = 1000, timeoutMs = 8000): Promise<Frame> {
    this.start();
    if (this.last && Date.now() - this.last.capturedAt <= maxAgeMs) return this.last;
    return new Promise<Frame>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(
          new Error(
            `No video frame from "${this.opts.device}" within ${timeoutMs} ms.` +
              (this.proc ? "" : " ffmpeg is not running.") +
              (this.stderrTail ? ` ffmpeg: ${this.stderrTail.trim()}` : ""),
          ),
        );
      }, timeoutMs);
      this.waiters.push((f) => {
        clearTimeout(t);
        resolve(f);
      });
    });
  }

  stop() {
    this.proc?.kill();
    this.proc = undefined;
  }
}

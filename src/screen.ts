/** Screen-watching loops that run server-side, at hardware speed. */
import type { Session } from "./session.js";
import type { Frame, KeyStroke } from "./hal/types.js";
import { thumbDiff, thumbOfPng, darkness, type Thumb } from "./util/frames.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WaitResult {
  frame: Frame;
  reached: boolean;
  elapsedMs: number;
  /** Largest frame-to-frame difference observed (0..1). */
  maxDiff: number;
  dark: number;
}

/**
 * until="change": return as soon as the screen differs from the first frame by > threshold.
 * until="stable": return once no frame differed by > threshold for `stableMs`.
 */
export async function waitScreen(
  session: Session,
  opts: { until: "change" | "stable"; timeoutMs: number; stableMs?: number; threshold?: number; intervalMs?: number },
): Promise<WaitResult> {
  const threshold = opts.threshold ?? 0.02;
  const interval = opts.intervalMs ?? 250;
  const stableMs = opts.stableMs ?? 1500;
  const t0 = Date.now();
  let frame = await session.capture();
  const first = thumbOfPng(frame.png);
  let prev = first;
  let lastChange = Date.now();
  let maxDiff = 0;

  while (Date.now() - t0 < opts.timeoutMs) {
    await sleep(interval);
    frame = await session.capture();
    const cur = thumbOfPng(frame.png);
    if (opts.until === "change") {
      const d = thumbDiff(first, cur);
      maxDiff = Math.max(maxDiff, d);
      if (d > threshold) return done(true, cur);
    } else {
      const d = thumbDiff(prev, cur);
      maxDiff = Math.max(maxDiff, d);
      if (d > threshold) lastChange = Date.now();
      else if (Date.now() - lastChange >= stableMs) return done(true, cur);
    }
    prev = cur;
  }
  return done(false, prev);

  function done(reached: boolean, t: Thumb): WaitResult {
    return { frame, reached, elapsedMs: Date.now() - t0, maxDiff, dark: darkness(t) };
  }
}

/**
 * Tap a key repeatedly until the screen changes, for windows too short for a
 * model round-trip: the BIOS setup key during POST, the boot-menu key, GRUB's
 * Shift/Esc, Windows' F8. Optionally triggers the boot itself first.
 */
export async function spamUntilChange(
  session: Session,
  stroke: KeyStroke,
  opts: {
    before?: "none" | "power_on" | "reset";
    intervalMs?: number;
    timeoutMs?: number;
    threshold?: number;
    /** Ignore changes for this long after `before` (POST logo flashes). */
    settleMs?: number;
    /** Stop once the screen has stayed changed-and-stable this long. */
    stableMs?: number;
  },
): Promise<{ reached: boolean; taps: number; elapsedMs: number; frame: Frame }> {
  const b = await session.get();
  const interval = opts.intervalMs ?? 120;
  const timeout = opts.timeoutMs ?? 45000;
  const threshold = opts.threshold ?? 0.08;
  const stableMs = opts.stableMs ?? 1200;

  if (opts.before === "power_on") {
    if (!b.pressPower) throw new Error(`Backend "${b.name}" cannot press the power button`);
    if (b.powerState && (await b.powerState()) === "on") {
      throw new Error("Target is already on; use before=\"reset\" or power it off first.");
    }
    await b.pressPower(300);
  } else if (opts.before === "reset") {
    if (b.pressReset) await b.pressReset(300);
    else {
      // Fall back to ctrl+alt+del, which works in most firmware and OSes.
      await b.tap({ usage: 0x4c, mods: 0x01 | 0x04 }, 100);
    }
  }

  const t0 = Date.now();
  let taps = 0;
  let reference: Thumb | undefined;
  let changedAt: number | undefined;
  let frame = await session.capture();
  let lastShot = 0;

  while (Date.now() - t0 < timeout) {
    await b.tap(stroke, 40);
    taps++;
    await sleep(interval);
    if (Date.now() - lastShot < 300) continue; // don't capture after every tap
    lastShot = Date.now();
    frame = await session.capture();
    const cur = thumbOfPng(frame.png);
    const elapsed = Date.now() - t0;
    if (elapsed < (opts.settleMs ?? 0) || darkness(cur) > 0.97) {
      reference = undefined; // black/no-signal phases are not a target screen
      continue;
    }
    if (!reference) {
      reference = cur;
      continue;
    }
    const d = thumbDiff(reference, cur);
    if (d > threshold) {
      // Screen moved to something new; keep tapping until it settles there.
      reference = cur;
      changedAt = Date.now();
    } else if (changedAt && Date.now() - changedAt >= stableMs) {
      return { reached: true, taps, elapsedMs: elapsed, frame };
    }
  }
  return { reached: false, taps, elapsedMs: Date.now() - t0, frame };
}

/**
 * Hardware abstraction layer.
 *
 * A Backend is "a pair of eyes and hands" attached to one target machine.
 * Every capability is optional except the screen and keyboard: a backend
 * advertises what it can do and tools degrade gracefully when something is
 * missing (e.g. DIY hardware without power wiring, or no virtual media).
 */

/** USB HID modifier bits (byte 0 of a boot keyboard report). */
export const Mod = {
  LCtrl: 0x01,
  LShift: 0x02,
  LAlt: 0x04,
  LGui: 0x08,
  RCtrl: 0x10,
  RShift: 0x20,
  RAlt: 0x40, // AltGr on ISO/ABNT2 layouts
  RGui: 0x80,
} as const;

/** A single key stroke: HID usage id (page 0x07) plus modifier mask. */
export interface KeyStroke {
  usage: number;
  mods: number;
}

export type MouseButton = "left" | "right" | "middle";

export interface Capabilities {
  screen: boolean;
  keyboard: boolean;
  mouseRelative: boolean;
  mouseAbsolute: boolean;
  /** Can press/hold the power and reset buttons. */
  power: boolean;
  /** Can read whether the target is powered (power LED / VM state). */
  powerSense: boolean;
  /** Can present an ISO/disk image to the target as boot media. */
  virtualMedia: boolean;
  /** Has a byte stream to a console on the target (serial/USB CDC). */
  console: boolean;
}

export interface Frame {
  png: Buffer;
  width: number;
  height: number;
  capturedAt: number;
}

export type PowerState = "on" | "off" | "unknown";

export interface Backend {
  readonly name: string;
  readonly capabilities: Capabilities;

  connect(): Promise<void>;
  close(): Promise<void>;

  // --- eyes ---
  capture(): Promise<Frame>;

  // --- hands: keyboard ---
  /** Press and release one stroke. */
  tap(stroke: KeyStroke, holdMs?: number): Promise<void>;
  keyDown(stroke: KeyStroke): Promise<void>;
  keyUp(stroke: KeyStroke): Promise<void>;
  releaseAll(): Promise<void>;

  // --- hands: mouse (optional) ---
  mouseMoveAbs?(x: number, y: number): Promise<void>; // normalized 0..1
  mouseMoveRel?(dx: number, dy: number): Promise<void>;
  mouseButton?(button: MouseButton, down: boolean): Promise<void>;
  mouseWheel?(delta: number): Promise<void>;

  // --- power (optional) ---
  pressPower?(holdMs: number): Promise<void>;
  pressReset?(holdMs: number): Promise<void>;
  powerState?(): Promise<PowerState>;

  // --- virtual media (optional) ---
  attachMedia?(imagePath: string): Promise<void>;
  ejectMedia?(): Promise<void>;

  // --- console (optional) ---
  consoleWrite?(data: Buffer): Promise<void>;
  /** Subscribe to console bytes; returns an unsubscribe function. */
  onConsoleData?(listener: (data: Buffer) => void): () => void;
}

export class UnsupportedError extends Error {
  constructor(backend: string, capability: string, hint?: string) {
    super(
      `Backend "${backend}" does not support ${capability}.` +
        (hint ? ` ${hint}` : ""),
    );
    this.name = "UnsupportedError";
  }
}

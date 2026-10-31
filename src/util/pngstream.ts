/**
 * Splits a concatenated stream of PNG files (ffmpeg `-f image2pipe -c:v png`)
 * into individual PNG buffers by walking the chunk structure.
 */
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class PngStreamSplitter {
  private buf: Buffer = Buffer.alloc(0);
  /** Offset of the next chunk header inside the current PNG, or -1 if not started. */
  private pos = -1;

  constructor(private readonly onFrame: (png: Buffer) => void) {}

  push(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.pos < 0) {
        const start = this.buf.indexOf(SIG);
        if (start < 0) {
          // Keep a tail in case the signature is split across chunks.
          this.buf = this.buf.subarray(Math.max(0, this.buf.length - SIG.length + 1));
          return;
        }
        this.buf = this.buf.subarray(start);
        this.pos = SIG.length;
      }
      if (this.buf.length < this.pos + 8) return;
      const len = this.buf.readUInt32BE(this.pos);
      const type = this.buf.toString("latin1", this.pos + 4, this.pos + 8);
      const end = this.pos + 12 + len; // length + type + data + crc
      if (this.buf.length < end) return;
      if (type === "IEND") {
        this.onFrame(Buffer.from(this.buf.subarray(0, end)));
        this.buf = this.buf.subarray(end);
        this.pos = -1;
      } else {
        this.pos = end;
      }
    }
  }
}

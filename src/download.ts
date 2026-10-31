/** Streaming downloads with SHA-256 verification. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Job } from "./jobs.js";

export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 200) || "download";
}

/**
 * Find the hash for `fileName` in a SHA256SUMS-style document
 * ("<hex>  name", "<hex> *name", or BSD style "SHA256 (name) = <hex>").
 */
export function findChecksum(sums: string, fileName: string): string | undefined {
  for (const raw of sums.split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
    if (m && path.basename(m[2]!.trim()) === fileName) return m[1]!.toLowerCase();
    m = /^SHA256\s*\((.+)\)\s*=\s*([a-fA-F0-9]{64})$/.exec(line);
    if (m && path.basename(m[1]!.trim()) === fileName) return m[2]!.toLowerCase();
  }
  return undefined;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  sha256: string;
  verified: boolean;
  expectedSha256?: string;
}

export async function download(
  url: string,
  destDir: string,
  opts: { fileName?: string; sha256?: string; sha256SumsUrl?: string; job?: Job<DownloadResult> } = {},
): Promise<DownloadResult> {
  fs.mkdirSync(destDir, { recursive: true });
  const fileName = safeFileName(opts.fileName ?? path.basename(new URL(url).pathname));
  const dest = path.join(destDir, fileName);
  const partial = `${dest}.part`;

  let expected = opts.sha256?.toLowerCase();
  if (!expected && opts.sha256SumsUrl) {
    const r = await fetch(opts.sha256SumsUrl);
    if (!r.ok) throw new Error(`Checksum list ${opts.sha256SumsUrl}: HTTP ${r.status}`);
    expected = findChecksum(await r.text(), path.basename(new URL(url).pathname));
    if (!expected) throw new Error(`No SHA-256 for ${fileName} in ${opts.sha256SumsUrl}`);
  }

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`GET ${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || undefined;
  const hash = createHash("sha256");
  let done = 0;
  if (opts.job) opts.job.progress = { done: 0, total };

  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
  body.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    done += chunk.length;
    if (opts.job) opts.job.progress = { done, total };
  });
  await pipeline(body, fs.createWriteStream(partial));

  const sha256 = hash.digest("hex");
  if (expected && sha256 !== expected) {
    fs.rmSync(partial, { force: true });
    throw new Error(`Checksum mismatch for ${fileName}: expected ${expected}, got ${sha256}. File deleted.`);
  }
  fs.renameSync(partial, dest);
  return { path: dest, bytes: done, sha256, verified: Boolean(expected), expectedSha256: expected };
}

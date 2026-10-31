/**
 * Hardware documentation library: download manuals (PDF or HTML) once, split
 * them into pages of plain text, and search them so the agent reads a few
 * relevant paragraphs instead of a 200-page PDF.
 *
 * Finding the right URL is the agent's job (web search on the vendor's
 * support site, guided by the skill); this module makes the content usable.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { download, safeFileName } from "./download.js";

const run = promisify(execFile);

export interface ManualMeta {
  id: string;
  title: string;
  url: string;
  kind: "pdf" | "html" | "text";
  pages: number;
  fetchedAt: string;
  tags: string[];
}

export interface SearchHit {
  manual: string;
  title: string;
  page: number;
  score: number;
  snippet: string;
}

export class ManualLibrary {
  constructor(private readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  private dir(id: string) {
    return path.join(this.root, safeFileName(id));
  }

  list(): ManualMeta[] {
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.root, d.name, "meta.json"), "utf8")) as ManualMeta;
        } catch {
          return undefined;
        }
      })
      .filter((m): m is ManualMeta => Boolean(m));
  }

  pages(id: string): string[] {
    return JSON.parse(fs.readFileSync(path.join(this.dir(id), "pages.json"), "utf8")) as string[];
  }

  async fetch(url: string, title: string, tags: string[] = [], id?: string): Promise<ManualMeta> {
    const mid = safeFileName(id ?? title.toLowerCase());
    const dir = this.dir(mid);
    const res = await download(url, dir, { fileName: "source" });
    const head = fs.readFileSync(res.path).subarray(0, 512).toString("latin1");

    let kind: ManualMeta["kind"];
    let pages: string[];
    if (head.startsWith("%PDF")) {
      kind = "pdf";
      pages = await pdfPages(res.path);
    } else if (/<html|<!doctype html/i.test(head)) {
      kind = "html";
      pages = paginate(htmlToText(fs.readFileSync(res.path, "utf8")));
    } else {
      kind = "text";
      pages = paginate(fs.readFileSync(res.path, "utf8"));
    }

    const meta: ManualMeta = { id: mid, title, url, kind, pages: pages.length, fetchedAt: new Date().toISOString(), tags };
    fs.writeFileSync(path.join(dir, "pages.json"), JSON.stringify(pages));
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    return meta;
  }

  search(query: string, opts: { manual?: string; limit?: number } = {}): SearchHit[] {
    const terms = tokenize(query);
    if (!terms.length) return [];
    const manuals = this.list().filter((m) => !opts.manual || m.id === opts.manual);
    const hits: SearchHit[] = [];
    for (const m of manuals) {
      const pages = this.pages(m.id);
      pages.forEach((text, i) => {
        const score = scorePage(text, terms, query);
        if (score > 0) hits.push({ manual: m.id, title: m.title, page: i + 1, score, snippet: snippet(text, terms) });
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 8);
  }
}

async function pdfPages(file: string): Promise<string[]> {
  try {
    // pdftotext separates pages with form feeds.
    const { stdout } = await run("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], { maxBuffer: 256 << 20 });
    const pages = stdout.split("\f");
    if (pages.length && !pages[pages.length - 1]!.trim()) pages.pop();
    return pages;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("pdftotext not found. Install poppler-utils (apt install poppler-utils / brew install poppler).");
    }
    throw e;
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split long text into ~3000-character "pages" on paragraph boundaries. */
export function paginate(text: string, size = 3000): string[] {
  const paras = text.split(/\n{2,}/);
  const pages: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length > size) {
      pages.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + p;
  }
  if (cur) pages.push(cur);
  return pages;
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2);
}

function scorePage(text: string, terms: string[], phrase: string): number {
  const tokens = tokenize(text);
  if (!tokens.length) return 0;
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  let score = 0;
  let matched = 0;
  for (const t of new Set(terms)) {
    const c = counts.get(t) ?? 0;
    if (c) {
      matched++;
      score += 1 + Math.log(c);
    }
  }
  if (!matched) return 0;
  score *= matched / new Set(terms).size; // favour pages matching every term
  if (text.toLowerCase().includes(phrase.toLowerCase())) score += 3;
  return Math.round(score * 100) / 100;
}

function snippet(text: string, terms: string[], radius = 220): string {
  const lower = text.toLowerCase();
  let best = 0;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0) {
      best = i;
      break;
    }
  }
  const s = Math.max(0, best - radius);
  return (s > 0 ? "…" : "") + text.slice(s, best + radius).replace(/\s+/g, " ").trim() + "…";
}

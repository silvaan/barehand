import path from "node:path";
import { z } from "zod";
import { download, type DownloadResult } from "../download.js";
import { getJob, listJobs, startJob } from "../jobs.js";
import { guarded, json, text, type Ctx } from "./common.js";

/** Read-only commands that identify the machine from a rescue Linux. */
const IDENTIFY = [
  // POSIX sh (busybox-safe): no brace expansion.
  "echo '## dmi'; for f in sys_vendor product_name product_version product_sku board_vendor board_name " +
    "board_version bios_vendor bios_version bios_date; do printf '%s: ' $f; cat /sys/class/dmi/id/$f 2>/dev/null || echo; done",
  "echo '## firmware'; [ -d /sys/firmware/efi ] && echo UEFI || echo BIOS/CSM; " +
    "cat /sys/firmware/efi/efivars/SecureBoot-* 2>/dev/null | od -An -t u1 | awk '{print \"secureboot=\" $NF}'",
  "echo '## cpu'; grep -m1 'model name' /proc/cpuinfo",
  "echo '## memory'; grep MemTotal /proc/meminfo",
  "echo '## disks'; lsblk -dno NAME,MODEL,SERIAL,SIZE,TRAN,ROTA -e7,11",
  "echo '## pci'; lspci -nn 2>/dev/null | grep -Ei 'vga|3d|display|sata|nvme|raid|ethernet|network' ",
].join("; ");

export function registerKnowledgeTools({ server, session, config, manuals }: Ctx) {
  server.registerTool(
    "hw_identify",
    {
      title: "Identify the target's hardware",
      description:
        "From the rescue shell, report vendor/model, motherboard, BIOS version and date, UEFI vs legacy, Secure " +
        "Boot, CPU, RAM, disks (model/serial/size) and key PCI devices. Without a console, read the same facts " +
        "from the BIOS setup main page or the POST screen instead. Use the result to find manuals.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      guarded(async () => {
        const c = await session.requireConsole();
        const r = await c.exec(IDENTIFY, 30000);
        return [text(r.output)];
      }),
  );

  server.registerTool(
    "manual_fetch",
    {
      title: "Download and index a hardware manual",
      description:
        "Download a manual or reference page (PDF or HTML) and index it page by page for manual_search. Find the " +
        "URL first with a web search on the vendor's support site using the exact model from hw_identify " +
        "(motherboard manual, laptop service/maintenance manual, POST/beep code table, BIOS guide). Re-fetching " +
        "the same id replaces it.",
      inputSchema: {
        url: z.string().url(),
        title: z.string().min(3).describe('e.g. "ASUS PRIME B450M-A user manual"'),
        id: z.string().optional().describe("short stable id; defaults to the title"),
        tags: z.array(z.string()).default([]).describe('e.g. ["motherboard","asus","b450"]'),
      },
    },
    ({ url, title, id, tags }) =>
      guarded(async () => {
        const meta = await manuals.fetch(url, title, tags, id);
        return [json(meta)];
      }),
  );

  server.registerTool(
    "manual_search",
    {
      title: "Search downloaded manuals",
      description:
        "Keyword search across downloaded manuals (or one, via `manual`). Returns the best pages with snippets " +
        'and page numbers; then read them with manual_read. Try specific terms: "front panel header", ' +
        '"Q-LED", "beep", "CMOS clear jumper", "boot menu F8", "M.2 SATA shared".',
      inputSchema: {
        query: z.string().min(2),
        manual: z.string().optional(),
        limit: z.number().int().min(1).max(30).default(8),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, manual, limit }) =>
      guarded(async () => {
        const hits = manuals.search(query, { manual, limit });
        if (!hits.length) {
          const have = manuals.list().map((m) => m.id);
          return [text(have.length ? `No matches. Manuals: ${have.join(", ")}` : "No manuals downloaded yet; use manual_fetch.")];
        }
        return [json(hits)];
      }),
  );

  server.registerTool(
    "manual_read",
    {
      title: "Read pages of a manual",
      description: "Return the text of specific pages (1-based) of a downloaded manual. Cite pages to the user.",
      inputSchema: {
        manual: z.string(),
        pages: z.array(z.number().int().min(1)).min(1).max(10),
      },
      annotations: { readOnlyHint: true },
    },
    ({ manual, pages }) =>
      guarded(async () => {
        const all = manuals.pages(manual);
        return pages.map((p) => text(`--- ${manual} · page ${p}/${all.length} ---\n${all[p - 1] ?? "(no such page)"}`));
      }),
  );

  server.registerTool(
    "manual_list",
    {
      title: "List downloaded manuals",
      description: "List manuals already in the local library (they persist between sessions).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guarded(async () => [json(manuals.list())]),
  );

  server.registerTool(
    "iso_download",
    {
      title: "Download an OS image in the background",
      description:
        "Start downloading an ISO/IMG into the local library and verify it against a SHA-256 (given directly or " +
        "looked up in a SHA256SUMS URL). Always use the distribution's official URL and checksum. Returns a job " +
        "id; poll with job_status. A checksum mismatch deletes the file.",
      inputSchema: {
        url: z.string().url(),
        sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
        sha256sums_url: z.string().url().optional(),
        file_name: z.string().optional(),
      },
    },
    ({ url, sha256, sha256sums_url, file_name }) =>
      guarded(async () => {
        const job = startJob<DownloadResult>("download", (j) =>
          download(url, path.join(config.workDir, "images"), {
            fileName: file_name,
            sha256,
            sha256SumsUrl: sha256sums_url,
            job: j,
          }),
        );
        const warn = sha256 || sha256sums_url ? "" : " WARNING: no checksum given, the image will not be verified.";
        return [text(`started ${job.id}.${warn}`)];
      }),
  );

  server.registerTool(
    "job_status",
    {
      title: "Check background jobs",
      description: "Status of a background job (download progress, result path, errors). Omit id to list all.",
      inputSchema: { id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      guarded(async () => {
        if (!id) return [json(listJobs())];
        const j = getJob(id);
        if (!j) throw new Error(`No job ${id}`);
        return [json(j)];
      }),
  );
}

// HTTP front-end to one slot's barehand MCP server, for agents that can only run shell commands.
//   POST / {"name": "<tool>", "arguments": {...}}  -> tool text; images saved under <slot>/shots/
//   {"name": "__describe"}                          -> every tool with its description and parameters
// Every call is appended to <slot>/calls.jsonl so a run can be reviewed afterwards.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { mcp, slot } from "./lib.mjs";

const s = slot(Number(process.argv[2]));
const shots = path.join(s.dir, "shots");
fs.mkdirSync(shots, { recursive: true });
let n = fs.readdirSync(shots).length;
const { client } = await mcp(s);
const journal = fs.createWriteStream(path.join(s.dir, "calls.jsonl"), { flags: "a" });

async function describe() {
  const { tools } = await client.listTools();
  return tools
    .map((t) => {
      const props = t.inputSchema?.properties ?? {};
      const req = new Set(t.inputSchema?.required ?? []);
      const params = Object.entries(props).map(([k, v]) => {
        const type = v.enum ? v.enum.map((e) => JSON.stringify(e)).join("|") : (v.type ?? "any");
        const def = v.default !== undefined ? ` = ${JSON.stringify(v.default)}` : "";
        return `    ${k}${req.has(k) && v.default === undefined ? "" : "?"}: ${type}${def}${v.description ? `  // ${v.description}` : ""}`;
      });
      return `## ${t.name}\n${t.description ?? ""}\n${params.join("\n")}`;
    })
    .join("\n\n");
}

http
  .createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const t0 = Date.now();
    let name = "?";
    let args = {};
    try {
      ({ name, arguments: args = {} } = JSON.parse(body || "{}"));
      if (name === "__describe") return res.end((await describe()) + "\n");
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 });
      const out = [];
      for (const c of r.content ?? []) {
        if (c.type === "text") out.push(c.text);
        else if (c.type === "image") {
          const f = path.join(shots, `${String(++n).padStart(3, "0")}-${name}.png`);
          fs.writeFileSync(f, Buffer.from(c.data, "base64"));
          out.push(`[screenshot saved: ${f}]`);
        }
      }
      const text = (r.isError ? "ERROR: " : "") + out.join("\n");
      journal.write(JSON.stringify({ t: new Date().toISOString(), ms: Date.now() - t0, name, args, error: !!r.isError, out: text.length > 4000 ? `${text.slice(0, 1000)}\n…\n${text.slice(-3000)}` : text }) + "\n");
      res.end(text + "\n");
    } catch (e) {
      journal.write(JSON.stringify({ t: new Date().toISOString(), ms: Date.now() - t0, name, args, error: true, out: String(e.message) }) + "\n");
      res.statusCode = 500;
      res.end(`ERROR: ${e.message}\n`);
    }
  })
  .listen(s.driverPort, "127.0.0.1", () => console.error(`driver for slot ${s.n} on 127.0.0.1:${s.driverPort}`));

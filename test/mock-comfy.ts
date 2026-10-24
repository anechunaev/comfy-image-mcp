// Minimal fake ComfyUI for offline tests: accepts workflows, returns a PNG.
// A workflow containing an "RMBG"-like node (class_type includes "RMBG") returns an RGBA PNG.
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w: number, h: number, alpha: boolean): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  const bpp = alpha ? 4 : 3;
  const raw = Buffer.alloc((w * bpp + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * bpp + 1)] = 0;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const jobs = new Map<string, { w: number; h: number; alpha: boolean; polls: number }>();
export const received: any[] = [];

export function startMock(port: number) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/system_stats") return json(200, { system: { comfyui_version: "mock" }, devices: [{ name: "cuda:0 NVIDIA GeForce RTX 3090", vram_total: 25769803776, vram_free: 24000000000 }] });
    if (url.pathname === "/upload/image") return json(200, { name: `upload-${received.length}.png`, subfolder: "", type: "input" });
    if (url.pathname === "/prompt") {
      const wf = JSON.parse(body.toString()).prompt;
      received.push(wf);
      const nodes = Object.values(wf) as any[];
      if (nodes.some((n) => n.class_type === "Broken")) return json(400, { error: { message: "Prompt outputs failed validation" }, node_errors: { "1": "Broken" } });
      const lat = nodes.find((n) => n.inputs?.width !== undefined);
      const id = `job${received.length}`;
      jobs.set(id, { w: lat?.inputs.width ?? 1024, h: lat?.inputs.height ?? 1024, alpha: nodes.some((n) => String(n.class_type).includes("RMBG")), polls: 0 });
      return json(200, { prompt_id: id });
    }
    if (url.pathname.startsWith("/history/")) {
      const id = url.pathname.split("/")[2]!;
      const j = jobs.get(id);
      if (!j || j.polls++ < 1) return json(200, {});
      return json(200, { [id]: { status: { status_str: "success", completed: true }, outputs: { "10": { images: [{ filename: `${id}.png`, subfolder: "claude", type: "output" }] } } } });
    }
    if (url.pathname === "/view") {
      const id = url.searchParams.get("filename")!.replace(".png", "");
      const j = jobs.get(id)!;
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(png(j.w, j.h, j.alpha));
    }
    json(404, {});
  });
  server.listen(port);
  return server;
}

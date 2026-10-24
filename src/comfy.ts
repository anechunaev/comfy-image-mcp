import { randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Background = "opaque" | "transparent" | "auto";

export interface GenerateOptions {
  prompt: string;
  /** Output path, relative to the project root (must end in .png). */
  out: string;
  /** "WIDTHxHEIGHT", e.g. "1536x1024". */
  size?: string;
  /** Reference images, relative to the project root. Switches to the edit workflow. */
  refs?: string[];
  background?: Background;
  seed?: number;
  negative?: string;
}

export interface GenerateContext {
  /** Absolute project root; outputs and refs must stay inside it. */
  root: string;
  /** Called about once a second while ComfyUI is working. */
  onProgress?: (elapsedSeconds: number) => void;
}

export interface GenerateResult {
  out: string;
  width: number;
  height: number;
  seed: number;
  workflow: string;
  notes: string[];
  png: Buffer;
}

interface ImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PH = /\{\{([A-Z0-9_]+)\}\}/g;

export const config = {
  url: (process.env.COMFYUI_URL ?? "").replace(/\/+$/, ""),
  workflowsDir: process.env.COMFY_WORKFLOWS_DIR ?? path.join(PKG_DIR, "workflows"),
  modelLabel: process.env.COMFY_MODEL_LABEL ?? "comfyui",
  maxMegapixels: Number(process.env.COMFY_MAX_MEGAPIXELS ?? "2.1"),
  timeoutMs: Number(process.env.COMFY_TIMEOUT_MS ?? "600000"),
  inlineMaxBytes: Number(process.env.COMFY_INLINE_MAX_BYTES ?? "3000000"),
  projectRoot: process.env.COMFY_PROJECT_ROOT,
};

function requireUrl(): string {
  if (!config.url) throw new Error("COMFYUI_URL is not set (e.g. http://192.168.1.50:8188).");
  return config.url;
}

export function resolveRoot(clientRoot?: string): string {
  const root = path.resolve(config.projectRoot || clientRoot || process.cwd());
  if (path.parse(root).root === root) {
    throw new Error(
      `The project root resolved to ${root}. Set COMFY_PROJECT_ROOT to the directory images should be written to.`,
    );
  }
  return root;
}

function insideRoot(root: string, p: string, what: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`${what} must be inside the project (${root}): ${p}`);
  }
  return abs;
}

export function fitSize(size: string | undefined, maxMp: number): { w: number; h: number; scaled: boolean } {
  const m = /^(\d+)x(\d+)$/.exec(size ?? "1536x1024");
  if (!m) throw new Error(`size must look like 1536x1024, got "${size}"`);
  let w = Number(m[1]);
  let h = Number(m[2]);
  let scaled = false;
  const limit = maxMp * 1_000_000;
  if (w * h > limit) {
    const k = Math.sqrt(limit / (w * h));
    w *= k;
    h *= k;
    scaled = true;
  }
  const snap = (v: number) => Math.max(256, Math.round(v / 16) * 16);
  return { w: snap(w), h: snap(h), scaled };
}

async function loadWorkflow(name: string): Promise<Json | null> {
  const file = path.join(config.workflowsDir, `${name}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, "utf8")) as Json;
}

export function fill(node: Json, values: Record<string, string | number>, missing: Set<string>): Json {
  if (typeof node === "string") {
    const whole = /^\{\{([A-Z0-9_]+)\}\}$/.exec(node);
    if (whole) {
      const key = whole[1]!;
      if (key in values) return values[key]!; // keeps numbers numeric
      missing.add(key);
      return node;
    }
    return node.replace(PH, (m, key: string) => {
      if (key in values) return String(values[key]);
      missing.add(key);
      return m;
    });
  }
  if (Array.isArray(node)) return node.map((n) => fill(n, values, missing));
  if (node && typeof node === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(node)) out[k] = fill(v, values, missing);
    return out;
  }
  return node;
}

function placeholders(node: Json): Set<string> {
  const found = new Set<string>();
  const s = JSON.stringify(node);
  for (const m of s.matchAll(PH)) found.add(m[1]!);
  return found;
}

async function upload(absPath: string): Promise<string> {
  const form = new FormData();
  const bytes = await readFile(absPath);
  form.append("image", new Blob([bytes]), `${randomUUID()}${path.extname(absPath) || ".png"}`);
  form.append("overwrite", "true");
  form.append("type", "input");
  const res = await fetch(`${requireUrl()}/upload/image`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`ComfyUI upload failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { name: string; subfolder?: string };
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

async function run(workflow: Json, onProgress?: (elapsedSeconds: number) => void): Promise<Buffer> {
  const base = requireUrl();
  const res = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ComfyUI rejected the workflow (${res.status}): ${body.slice(0, 1500)}`);
  }
  const { prompt_id } = (await res.json()) as { prompt_id: string };

  const started = Date.now();
  const deadline = started + config.timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    onProgress?.(Math.round((Date.now() - started) / 1000));
    const h = await fetch(`${base}/history/${prompt_id}`);
    if (!h.ok) continue;
    const hist = (await h.json()) as Record<string, any>;
    const entry = hist[prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      const msgs = (entry.status.messages ?? [])
        .filter((m: any[]) => m[0] === "execution_error")
        .map((m: any[]) => `${m[1]?.node_type}: ${m[1]?.exception_message}`);
      throw new Error(`ComfyUI execution failed: ${msgs.join("; ") || "unknown error"}`);
    }
    if (entry.status && entry.status.completed === false) continue;
    const images: ImageRef[] = Object.values(entry.outputs ?? {}).flatMap((o: any) => o.images ?? []);
    const img = images.find((i) => i.type === "output") ?? images[0];
    if (!img) throw new Error("ComfyUI finished but produced no image. Does the workflow end in a SaveImage node?");
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? "", type: img.type });
    const v = await fetch(`${base}/view?${q}`);
    if (!v.ok) throw new Error(`Could not download result: ${v.status}`);
    return Buffer.from(await v.arrayBuffer());
  }
  throw new Error(`Timed out after ${config.timeoutMs / 1000}s waiting for ComfyUI (job ${prompt_id}).`);
}

export function pngInfo(buf: Buffer): { width: number; height: number; alpha: boolean } {
  const sig = "89504e470d0a1a0a";
  if (buf.subarray(0, 8).toString("hex") !== sig) throw new Error("ComfyUI returned something that is not a PNG.");
  const colorType = buf[25]!;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), alpha: colorType === 4 || colorType === 6 };
}

export async function status(root: string): Promise<string> {
  const res = await fetch(`${requireUrl()}/system_stats`);
  if (!res.ok) throw new Error(`ComfyUI answered ${res.status}`);
  const s = (await res.json()) as any;
  const dev = s.devices?.[0];
  const gb = (b: number) => (b / 1024 ** 3).toFixed(1);
  const wf = ["txt2img", "edit", "cutout"].map((n) => `${n}: ${existsSync(path.join(config.workflowsDir, `${n}.json`)) ? "yes" : "no"}`);
  return [
    `ComfyUI ${s.system?.comfyui_version ?? "?"} at ${config.url}`,
    dev ? `GPU: ${dev.name} (VRAM free ${gb(dev.vram_free)} / ${gb(dev.vram_total)} GB)` : "GPU: unknown",
    `Workflows (${config.workflowsDir}): ${wf.join(", ")}`,
    `Project root: ${root}`,
  ].join("\n");
}

export async function generate(opts: GenerateOptions, ctx: GenerateContext): Promise<GenerateResult> {
  const { root, onProgress } = ctx;
  if (!opts.prompt?.trim()) throw new Error("prompt is required");
  if (!opts.out?.toLowerCase().endsWith(".png")) throw new Error("out must be a .png path");
  const outAbs = insideRoot(root, opts.out, "out");
  const notes: string[] = [];
  const refs = opts.refs ?? [];
  const background = opts.background ?? "auto";

  const workflowName = refs.length ? "edit" : "txt2img";
  const template = await loadWorkflow(workflowName);
  if (!template) {
    throw new Error(
      refs.length
        ? `Reference images need workflows/edit.json, which is not set up. Retry without refs, or add an edit workflow.`
        : `workflows/txt2img.json is missing in ${config.workflowsDir}.`,
    );
  }

  const { w, h, scaled } = fitSize(opts.size, config.maxMegapixels);
  const seed = opts.seed ?? randomInt(0, 2 ** 32);

  const values: Record<string, string | number> = {
    PROMPT: opts.prompt,
    NEGATIVE: opts.negative ?? "",
    SEED: seed,
    WIDTH: w,
    HEIGHT: h,
    FILENAME_PREFIX: "comfy-image-mcp/image",
  };

  const available = placeholders(template);
  if (available.has("WIDTH") || available.has("HEIGHT")) {
    if (scaled) notes.push(`size scaled down to ${w}x${h} to stay under ${config.maxMegapixels} MP`);
  } else if (opts.size) {
    notes.push(`${workflowName}.json has no {{WIDTH}}/{{HEIGHT}}, so size was ignored and the workflow's own sizing was used`);
  }
  if (opts.negative && !available.has("NEGATIVE")) {
    notes.push(`${workflowName}.json has no {{NEGATIVE}}, so the negative prompt was ignored`);
  }
  if (refs.length) {
    const slots = ["REF_IMAGE", "REF_IMAGE_2", "REF_IMAGE_3", "REF_IMAGE_4"].filter((s) => available.has(s));
    if (!slots.length) throw new Error("edit.json has no {{REF_IMAGE}} placeholder.");
    if (refs.length > slots.length) notes.push(`only the first ${slots.length} reference image(s) were used`);
    for (let i = 0; i < Math.min(refs.length, slots.length); i++) {
      values[slots[i]!] = await upload(insideRoot(root, refs[i]!, "ref"));
    }
  }

  const missing = new Set<string>();
  const wf = fill(template, values, missing);
  if (missing.size) throw new Error(`${workflowName}.json has unknown placeholders: ${[...missing].join(", ")}`);
  let png = await run(wf, onProgress);

  if (background === "transparent") {
    const cut = await loadWorkflow("cutout");
    if (!cut) throw new Error("background=transparent needs workflows/cutout.json (background removal), which is not set up.");
    await mkdir(path.dirname(outAbs), { recursive: true });
    const tmp = `${outAbs}.opaque.png`;
    await writeFile(tmp, png);
    const cutMissing = new Set<string>();
    const cutWf = fill(cut, { INPUT_IMAGE: await upload(tmp), FILENAME_PREFIX: "comfy-image-mcp/cutout" }, cutMissing);
    if (cutMissing.size) throw new Error(`cutout.json has unknown placeholders: ${[...cutMissing].join(", ")}`);
    png = await run(cutWf, onProgress);
    if (!pngInfo(png).alpha) throw new Error("cutout workflow returned a PNG without an alpha channel.");
    notes.push(`opaque source kept at ${path.relative(root, tmp)}`);
  }

  const info = pngInfo(png);
  await mkdir(path.dirname(outAbs), { recursive: true });
  await writeFile(outAbs, png);

  const sidecar = {
    prompt: opts.prompt,
    ...(opts.negative ? { negative: opts.negative } : {}),
    createdAt: new Date().toISOString(),
    tool: "comfy-image-mcp",
    model: config.modelLabel,
    workflow: workflowName,
    seed,
    size: `${info.width}x${info.height}`,
    background,
    ...(refs.length ? { refs } : {}),
  };
  await writeFile(`${outAbs}.json`, JSON.stringify(sidecar, null, 2) + "\n");

  return {
    out: path.relative(root, outAbs),
    width: info.width,
    height: info.height,
    seed,
    workflow: workflowName,
    notes,
    png,
  };
}

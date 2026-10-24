#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PKG_DIR, config, generate, resolveRoot, status } from "./comfy.ts";

const { version } = JSON.parse(readFileSync(path.join(PKG_DIR, "package.json"), "utf8")) as { version: string };
const server = new McpServer({ name: "comfy-image", version });
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

let clientRoot: Promise<string | undefined> | undefined;

async function firstClientRoot(): Promise<string | undefined> {
  if (config.projectRoot || !server.server.getClientCapabilities()?.roots) return undefined;
  try {
    const { roots } = await server.server.listRoots();
    const uri = roots.find((r) => r.uri.startsWith("file://"))?.uri;
    return uri ? fileURLToPath(uri) : undefined;
  } catch {
    return undefined;
  }
}

async function projectRoot(): Promise<string> {
  clientRoot ??= firstClientRoot();
  return resolveRoot(await clientRoot);
}

server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
  clientRoot = undefined;
});

server.registerTool(
  "generate_image",
  {
    title: "Generate image (ComfyUI)",
    description: [
      "Generates an image with a diffusion model running in ComfyUI on a GPU machine. No API key or per-image cost.",
      "Use it for design mockups, reference-guided variations and edits (pass `refs`), and finished raster assets such as illustrations, photos, textures and transparent cutouts.",
      "The PNG is written to `out`, relative to the project root, with a `<out>.json` sidecar recording the prompt, seed and settings. The image is also returned in the result when it is small enough.",
      "Each call takes roughly 20-120 s, so make calls one at a time. Local models render small text poorly: describe layout, hierarchy, palette, type character and imagery, keep quoted copy to short headlines, and do not rely on body text.",
    ].join(" "),
    inputSchema: {
      prompt: z.string().min(1).describe("Full image prompt. Lead with structure/composition, then style, palette, type character."),
      out: z.string().describe("Output .png path relative to the project root, e.g. mocks/hero-a.png"),
      size: z
        .string()
        .regex(/^\d+x\d+$/)
        .optional()
        .describe("WIDTHxHEIGHT. Default 1536x1024. Large sizes are scaled down to the configured megapixel cap. Edit workflows may size from the reference instead."),
      refs: z
        .array(z.string())
        .max(4)
        .optional()
        .describe("Reference image paths (project-relative), e.g. a screenshot or a crop. Uses the edit workflow."),
      background: z
        .enum(["opaque", "transparent", "auto"])
        .optional()
        .describe("transparent = run background removal and return a PNG with alpha (for cutouts)."),
      seed: z.number().int().nonnegative().optional().describe("Fix the seed to make a variation reproducible."),
      negative: z.string().optional().describe("Negative prompt, if the workflow uses one."),
    },
  },
  async (args, extra) => {
    try {
      const token = extra._meta?.progressToken;
      let progress = 0;
      const onProgress = token === undefined
        ? undefined
        : (elapsed: number) => {
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: { progressToken: token, progress: ++progress, message: `ComfyUI working (${elapsed}s)` },
              })
              .catch(() => {});
          };
      const r = await generate(args, { root: await projectRoot(), onProgress });
      const inline = r.png.length <= config.inlineMaxBytes;
      const lines = [
        `IMAGE: ${r.out} (${r.width}x${r.height}, ${config.modelLabel} via ComfyUI, workflow ${r.workflow}, seed ${r.seed})`,
        `Sidecar: ${r.out}.json`,
        ...(inline ? [] : [`Image not attached (${(r.png.length / 1e6).toFixed(1)} MB is over COMFY_INLINE_MAX_BYTES); open the file to view it.`]),
        ...r.notes.map((n) => `Note: ${n}`),
      ];
      return {
        content: [
          { type: "text" as const, text: lines.join("\n") },
          ...(inline ? [{ type: "image" as const, data: r.png.toString("base64"), mimeType: "image/png" }] : []),
        ],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: `generate_image failed: ${errorText(e)}` }] };
    }
  },
);

server.registerTool(
  "image_backend_status",
  {
    title: "Check the image backend",
    description: "Reports whether ComfyUI is reachable, GPU/VRAM, which workflows (txt2img, edit, cutout) are configured, and the project root images are written to. Does not generate anything.",
    inputSchema: {},
  },
  async () => {
    let root: string;
    try {
      root = await projectRoot();
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: errorText(e) }] };
    }
    try {
      return { content: [{ type: "text" as const, text: await status(root) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: `ComfyUI unreachable at ${config.url || "(COMFYUI_URL unset)"}: ${errorText(e)}` }] };
    }
  },
);

await server.connect(new StdioServerTransport());
console.error(`comfy-image MCP ${version} ready (ComfyUI: ${config.url || "unset"})`);

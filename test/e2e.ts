import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startMock, received } from "./mock-comfy.ts";

const here = path.dirname(new URL(import.meta.url).pathname);
const proj = path.join(here, ".proj");
rmSync(proj, { recursive: true, force: true });
mkdirSync(proj, { recursive: true });
writeFileSync(path.join(proj, "shot.png"), readFileSync(path.join(here, "..", "package.json"))); // any bytes

const mock = startMock(18188);
const baseEnv = { ...process.env as Record<string, string>, COMFYUI_URL: "http://127.0.0.1:18188/", COMFY_WORKFLOWS_DIR: path.join(here, "fixtures"), COMFY_MODEL_LABEL: "qwen-image-fp8" };
delete baseEnv.COMFY_PROJECT_ROOT;

async function connect(cwd: string, env: Record<string, string> = {}, roots?: string[]) {
  const client = new Client({ name: "test", version: "0" }, roots ? { capabilities: { roots: {} } } : {});
  if (roots) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: roots.map((r) => ({ uri: pathToFileURL(r).href })) }));
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "..", "src", "server.ts")],
    cwd,
    env: { ...baseEnv, ...env },
  }));
  return client;
}

const client = await connect(proj);
const call = async (args: any, c = client) => (await c.callTool({ name: "generate_image", arguments: args })) as any;
const text = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

const tools = await client.listTools();
assert.deepEqual(tools.tools.map((t) => t.name).sort(), ["generate_image", "image_backend_status"]);

let r: any = await client.callTool({ name: "image_backend_status", arguments: {} });
console.log(text(r)); assert.match(text(r), /RTX 3090/);

// 1. txt2img, default size, image returned inline
r = await call({ prompt: "Landing page hero, editorial layout", out: "mocks/a.png", seed: 7 });
console.log(text(r)); assert.ok(!r.isError);
const wf1 = received.at(-1);
assert.equal(wf1["5"].inputs.text, "Landing page hero, editorial layout");
assert.equal(wf1["7"].inputs.width, 1536); assert.equal(wf1["8"].inputs.seed, 7);
const img = r.content.find((c: any) => c.type === "image");
assert.equal(img?.mimeType, "image/png");
assert.deepEqual(Buffer.from(img.data, "base64"), readFileSync(path.join(proj, "mocks/a.png")));
const side = JSON.parse(readFileSync(path.join(proj, "mocks/a.png.json"), "utf8"));
assert.equal(side.model, "qwen-image-fp8"); assert.equal(side.size, "1536x1024");

// 2. oversize gets capped and snapped to /16
r = await call({ prompt: "x", out: "big.png", size: "3072x2048" });
console.log(text(r)); assert.match(text(r), /scaled down/);
assert.equal(received.at(-1)["7"].inputs.width % 16, 0);

// 3. refs -> edit workflow, uploads both; edit fixture has no NEGATIVE placeholder
r = await call({ prompt: "variation", out: "b.png", refs: ["shot.png", "shot.png"], negative: "blurry" });
console.log(text(r)); assert.match(text(r), /workflow edit/);
assert.match(received.at(-1)["1"].inputs.image, /^upload-/);
assert.match(text(r), /negative prompt was ignored/);

// 4. transparent -> cutout second pass with alpha
r = await call({ prompt: "cutout mascot", out: "assets/c.png", background: "transparent" });
console.log(text(r)); assert.ok(!r.isError, text(r));
assert.equal(received.at(-1)["2"].class_type, "RMBG");
assert.equal(readFileSync(path.join(proj, "assets/c.png"))[25], 6);

// 5. path escape rejected; non-png rejected; ref outside rejected; "..name" is fine
r = await call({ prompt: "x", out: "../evil.png" }); assert.ok(r.isError); console.log(text(r));
r = await call({ prompt: "x", out: "a.jpg" }); assert.ok(r.isError);
r = await call({ prompt: "x", out: "d.png", refs: ["/etc/passwd"] }); assert.ok(r.isError);
assert.ok(!existsSync(path.join(proj, "..", "evil.png")));
r = await call({ prompt: "x", out: "..dots.png" }); assert.ok(!r.isError, text(r));
await client.close();

// 6. the client's roots win over cwd
const elsewhere = path.join(proj, "elsewhere");
const rootsDir = path.join(proj, "from-roots");
mkdirSync(elsewhere); mkdirSync(rootsDir);
const rootsClient = await connect(elsewhere, {}, [rootsDir]);
let progressEvents = 0;
r = await rootsClient.callTool({ name: "generate_image", arguments: { prompt: "x", out: "r.png" } }, undefined, { onprogress: () => { progressEvents++; } });
assert.ok(!r.isError, text(r)); assert.ok(progressEvents > 0, "progress notifications sent");
assert.ok(existsSync(path.join(rootsDir, "r.png")));
await rootsClient.close();

// 7. COMFY_PROJECT_ROOT wins over roots and cwd; inline image can be disabled
const pinned = path.join(proj, "pinned");
mkdirSync(pinned);
const pinnedClient = await connect(elsewhere, { COMFY_PROJECT_ROOT: pinned, COMFY_INLINE_MAX_BYTES: "0" }, [rootsDir]);
r = await call({ prompt: "x", out: "p.png" }, pinnedClient); assert.ok(!r.isError, text(r));
assert.ok(existsSync(path.join(pinned, "p.png")));
assert.ok(!r.content.some((c: any) => c.type === "image")); assert.match(text(r), /not attached/);
await pinnedClient.close();

// 8. filesystem root is refused
const rootClient = await connect("/");
r = await call({ prompt: "x", out: "nope.png" }, rootClient); assert.ok(r.isError); assert.match(text(r), /COMFY_PROJECT_ROOT/);
await rootClient.close();

mock.close();
console.log("\nALL E2E CHECKS PASSED");

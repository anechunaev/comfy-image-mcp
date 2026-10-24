# comfy-image-mcp

An [MCP](https://modelcontextprotocol.io) server that turns your own ComfyUI workflows into an image-generation tool for any MCP client: Claude Code, Claude Desktop, Cursor, VS Code, Codex CLI, Gemini CLI and others. ComfyUI can run on the same machine or on a GPU box elsewhere on your LAN. You need no API key and pay nothing per image.

The server exposes two tools:

- **`generate_image`** runs a txt2img, reference-edit or background-removal workflow. It writes the PNG and a `<out>.json` prompt sidecar into your project, and also returns the image to the client.
- **`image_backend_status`** reports whether ComfyUI is reachable, the GPU and free VRAM, which workflows are configured, and which directory images are written to.

```
Machine running your MCP client                       GPU machine
┌─────────────────────────────────────┐   HTTP :8188  ┌────────────────────────┐
│ MCP client (Claude Code, Cursor, …) │               │ ComfyUI                │
│   └─ generate_image ───────────────┐│ ────────────▶ │  txt2img.json          │
│      (comfy-image-mcp, stdio)      ││  /prompt      │  edit.json   (refs)    │
│   ◀─ PNG + sidecar in project,─────┘│  /upload      │  cutout.json (alpha)   │
│      image in the tool result       │ ◀──────────── │                        │
└─────────────────────────────────────┘  /view        └────────────────────────┘
```

---

## 1. Set up ComfyUI

The walkthrough below uses a Windows PC with an NVIDIA GPU as the GPU machine. If ComfyUI runs on the same machine as your MCP client, skip step 1.4 and use `http://127.0.0.1:8188`.

### 1.1 Install ComfyUI

1. Update the GPU driver.
2. Download **ComfyUI Windows Portable (NVIDIA)** from the ComfyUI GitHub releases and extract it to a short path such as `C:\ComfyUI`. ComfyUI Desktop and Linux installs work too. The only difference is where you set the listen address (step 1.4).
3. Run `run_nvidia_gpu.bat` once, then open `http://127.0.0.1:8188` to confirm it starts.
4. Use a recent ComfyUI release. The shipped workflows rely on core nodes that older versions don't have: the switch nodes, `TextEncodeQwenImageEditPlus`, and the background-removal nodes. You don't need any custom nodes.

### 1.2 Download the models

The workflows in `workflows/` are API exports of ComfyUI's Qwen-Image 2512 and Qwen-Image-Edit 2511 templates. They need these files:

| File | ComfyUI folder | Used by |
|---|---|---|
| `qwen_image_2512_fp8_e4m3fn.safetensors` | `models/diffusion_models` | `txt2img.json` |
| `qwen_image_edit_2511_fp8mixed.safetensors` | `models/diffusion_models` | `edit.json` |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `models/text_encoders` | both |
| `qwen_image_vae.safetensors` | `models/vae` | both |
| `Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors` | `models/loras` | `txt2img.json` (4-step switch) |
| `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | `models/loras` | `edit.json` (4-step switch) |
| `birefnet.safetensors` | where *Load Background Removal Model* looks for models | `cutout.json` |

The easiest way to get them is from ComfyUI itself: open **Workflow → Browse Templates**, then the **Qwen-Image 2512** and **Qwen-Image-Edit 2511** templates. Each template lists its models and offers to download them into the right folders. Generate one image in the UI before you continue.

Both workflows ship with the Lightning 4-step LoRA switched **off**. txt2img runs 30 steps at CFG 4, and edit runs 40 steps at CFG 4. To use the LoRA, set the *Enable 4 Steps LoRA?* boolean to `true` in the JSON, which gives 4 steps at CFG 1. ComfyUI checks every model name in a workflow, so keep the LoRA files installed even while the switch is off.

> Each diffusion model is about 20 GB in fp8. On a 24 GB card only one fits in VRAM at a time, so the first call after switching between plain generation and reference edits is slower while ComfyUI swaps models.

Other models work as well. Export your own workflow (section 2) and point the server at it. Some options as of 2026 (this area moves fast):

| Model | Notes |
|---|---|
| Qwen-Image / Qwen-Image-Edit | Strong at in-image text and layout. Apache-2.0. |
| FLUX.2 dev (quantized) | Excellent prompt-following. Non-commercial licence unless you buy a BFL licence. |
| Z-Image Turbo | A few seconds per image. Good for quick drafts. |

### 1.3 Check the result

Run each workflow once in the ComfyUI UI. A missing model file shows up there as a red node. Through the server, it shows up as `rejected the workflow (400)`.

### 1.4 Make ComfyUI reachable from the LAN (remote GPU only)

1. Add the listen flags to the python line in `run_nvidia_gpu.bat`:
   ```
   .\python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --listen 0.0.0.0 --port 8188
   ```
   In ComfyUI Desktop, go to Settings → Server-Config → Host `0.0.0.0`.
2. Give both machines fixed addresses, for example with a DHCP reservation on the router. The examples below use `192.168.1.50` for the GPU machine and `192.168.1.20` for the client machine.
3. **ComfyUI has no authentication**, so open the port only to the client machine. Run this in an admin PowerShell:
   ```powershell
   New-NetFirewallRule -DisplayName "ComfyUI (MCP client only)" -Direction Inbound -Protocol TCP `
     -LocalPort 8188 -RemoteAddress 192.168.1.20 -Profile Private -Action Allow
   ```
   Make sure the Windows network profile is **Private**, and never port-forward 8188 on the router.
4. Keep the PC from sleeping while you work.

---

## 2. Workflows

The server reads up to three API-format workflows from `COMFY_WORKFLOWS_DIR`. By default that is the `workflows/` folder shipped with the package.

| File | Required | Enables |
|---|---|---|
| `txt2img.json` | yes | plain generation |
| `edit.json` | no | `refs` (reference images) |
| `cutout.json` | no | `background: "transparent"`: runs as a second pass over the generated image and must output RGBA |

`workflows/examples/qwen-image.txt2img.json` is a smaller hand-written graph for the original Qwen-Image model (`qwen_image_fp8_e4m3fn.safetensors`). It's a useful starting point if you write your own.

To use your own workflows, copy the shipped ones (or export new ones) into a folder of your own and set `COMFY_WORKFLOWS_DIR` to that folder. Don't edit them inside `node_modules`.

### Exporting a workflow

Open the workflow in ComfyUI and choose **Workflow → Export (API)**. Then open the JSON in an editor and replace the relevant values with placeholders:

| Placeholder | Put it in | Notes |
|---|---|---|
| `"{{PROMPT}}"` | positive text-encode node (`text` / `prompt`) | required |
| `"{{NEGATIVE}}"` | negative text-encode node | optional. Without it, the `negative` argument is ignored and the tool says so |
| `"{{SEED}}"` | KSampler `seed` | recommended |
| `"{{WIDTH}}"`, `"{{HEIGHT}}"` | empty-latent node | recommended for txt2img. Without them, `size` is ignored and the tool says so |
| `"{{REF_IMAGE}}"` … `"{{REF_IMAGE_4}}"` | `LoadImage.image` | `edit.json` only. Extra refs beyond the available slots are dropped |
| `"{{INPUT_IMAGE}}"` | `LoadImage.image` | `cutout.json` only |
| `"{{FILENAME_PREFIX}}"` | `SaveImage.filename_prefix` | optional. Results land in ComfyUI's `output/comfy-image-mcp/` |

A placeholder that makes up a whole value, such as `"{{WIDTH}}"`, is replaced with a real number, so numeric fields stay numeric. Any unknown `{{…}}` placeholder is an error.

How the shipped workflows behave:

- **`txt2img.json`** has a fixed Chinese negative prompt (taken from the template) and no `{{NEGATIVE}}`.
- **`edit.json`** has two reference slots, and sizes its output from the first reference (`FluxKontextImageScale`), so `size` is ignored. The tool always reports the size it actually got.
- **`cutout.json`** uses the core *Remove Background* node with BiRefNet, then joins the inverted mask back on as alpha.

---

## 3. Install

You need Node.js **22 or later**.

```bash
npx -y comfy-image-mcp        # what MCP clients run; it waits on stdin, so Ctrl-C to exit
```

To work on it, or to smoke-test against your ComfyUI first, use a clone instead. This needs Node 22.18 or later, because the dev scripts run the `.ts` sources directly.

```bash
git clone <this repo> comfy-image-mcp && cd comfy-image-mcp
npm install
npm test                      # offline end-to-end test against a mock ComfyUI

export COMFYUI_URL=http://192.168.1.50:8188
npm run status
npm run gen -- --prompt "SaaS landing page hero, editorial serif headline \"Ship calmer\", warm off-white" \
  --out tmp/test.png --size 1536x1024
npm run gen -- --prompt "friendly paper-cut fox mascot" --out tmp/fox.png --size 1024x1024 --background transparent
```

In a clone, a client can also run `node /path/to/comfy-image-mcp/src/server.ts` instead of `npx -y comfy-image-mcp`.

---

## 4. Connect your MCP client

Every client needs the same three things: the command `npx -y comfy-image-mcp`, `COMFYUI_URL`, and a project root (below). The snippets use `192.168.1.50`. Replace it with your own address, or with `127.0.0.1` if ComfyUI runs locally.

### Where images are written

`out` and `refs` are paths relative to a **project root**, and the server refuses paths outside it. The root is picked in this order:

1. `COMFY_PROJECT_ROOT`, if set.
2. The first `file://` root the client reports through MCP *roots*, if the client supports them.
3. The directory the client started the server in.

If that ends up being `/` (Claude Desktop, for example, starts servers there), the server refuses to write and asks for `COMFY_PROJECT_ROOT`. Use `image_backend_status` to see which root is in effect.

### Claude Code

```bash
claude mcp add comfy-image --scope user \
  -e COMFYUI_URL=http://192.168.1.50:8188 \
  -e COMFY_MODEL_LABEL=qwen-image-2512 \
  -- npx -y comfy-image-mcp

claude mcp list               # comfy-image should show as connected
```

Claude Code starts the server in the directory you launched `claude` from, so outputs land in that project. Start `claude` from the project root.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config). Claude Desktop doesn't start servers in a project directory, so set the root explicitly:

```json
{
  "mcpServers": {
    "comfy-image": {
      "command": "npx",
      "args": ["-y", "comfy-image-mcp"],
      "env": {
        "COMFYUI_URL": "http://192.168.1.50:8188",
        "COMFY_PROJECT_ROOT": "/home/you/Pictures/comfy"
      }
    }
  }
}
```

The image comes back in the tool result, so it shows in the chat.

### Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for all projects:

```json
{
  "mcpServers": {
    "comfy-image": {
      "command": "npx",
      "args": ["-y", "comfy-image-mcp"],
      "env": {
        "COMFYUI_URL": "http://192.168.1.50:8188",
        "COMFY_PROJECT_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

### VS Code (Copilot agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "comfy-image": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "comfy-image-mcp"],
      "env": {
        "COMFYUI_URL": "http://192.168.1.50:8188",
        "COMFY_PROJECT_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.comfy-image]
command = "npx"
args = ["-y", "comfy-image-mcp"]
env = { COMFYUI_URL = "http://192.168.1.50:8188" }
tool_timeout_sec = 600
```

### Gemini CLI

`.gemini/settings.json` in the project, or `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "comfy-image": {
      "command": "npx",
      "args": ["-y", "comfy-image-mcp"],
      "env": { "COMFYUI_URL": "http://192.168.1.50:8188" },
      "timeout": 600000
    }
  }
}
```

### Other clients

Any client that can launch a stdio MCP server works with the same command and environment. Two things to check:

- **Root.** If `image_backend_status` shows the wrong project root, set `COMFY_PROJECT_ROOT`.
- **Timeout.** A cold model load plus a large image can take a minute or two, and many clients give up on a tool call after about 60 s by default. Raise the client's tool timeout to around 10 minutes: `MCP_TOOL_TIMEOUT=600000` for Claude Code, `tool_timeout_sec` for Codex, `timeout` for Gemini CLI. While a job runs, the server sends MCP progress notifications whenever the client asks for them, and some clients use those to keep the call alive.

### Optional: tell the agent about it

Most agents find the tool from its description. A short note in your project's agent instructions (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, …) still helps:

```markdown
## Image generation
- Use `generate_image` (comfy-image MCP, local ComfyUI) for mockups, illustrations and other raster assets.
  Pass `refs` for reference-guided edits and `background: "transparent"` for cutouts.
- It is slow (~20–120 s) and free; generate one image at a time. Check `image_backend_status` if a call fails.
- Local models garble small text: describe layout, hierarchy, palette and type character; keep quoted copy to headlines.
```

In Claude Code, you can skip the permission prompt on every call by adding this to `.claude/settings.json` or `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__comfy-image__generate_image", "mcp__comfy-image__image_backend_status"]
  }
}
```

---

## Reference

### Tools

`generate_image({ prompt, out, size?, refs?, background?, seed?, negative? })`

| Argument | |
|---|---|
| `prompt` | the image prompt (required) |
| `out` | `.png` path relative to the project root (required). Missing folders are created |
| `size` | `WIDTHxHEIGHT`, default `1536x1024`. Sizes over `COMFY_MAX_MEGAPIXELS` are scaled down, and every size snaps to a multiple of 16 |
| `refs` | up to 4 project-relative reference images. Uses `edit.json` |
| `background` | `opaque`, `auto` (default) or `transparent`. `transparent` runs `cutout.json` afterwards and keeps the opaque original as `<out>.opaque.png` |
| `seed` | fix it for reproducible variations. The seed used is always reported |
| `negative` | negative prompt, used only if the workflow has `{{NEGATIVE}}` |

The result has a text summary (path, size, workflow, seed, notes) and the PNG as an MCP image block, as long as the PNG is no larger than `COMFY_INLINE_MAX_BYTES`. Next to the image the server writes `<out>.json`:

```json
{
  "prompt": "…",
  "createdAt": "2026-10-24T12:00:00.000Z",
  "tool": "comfy-image-mcp",
  "model": "qwen-image-2512",
  "workflow": "txt2img",
  "seed": 123456789,
  "size": "1536x1024",
  "background": "auto"
}
```

`negative` and `refs` are added to it when you use them. The PNG also carries ComfyUI's own embedded workflow metadata.

`image_backend_status()` reports the ComfyUI version, the GPU and free VRAM, which workflows are present, and the project root. It doesn't generate anything.

### Environment

| Var | Default | |
|---|---|---|
| `COMFYUI_URL` | (required) | e.g. `http://192.168.1.50:8188` |
| `COMFY_WORKFLOWS_DIR` | the package's `workflows/` | where `txt2img.json`, `edit.json` and `cutout.json` live |
| `COMFY_PROJECT_ROOT` | client root, else cwd | outputs and refs must stay inside it |
| `COMFY_MODEL_LABEL` | `comfyui` | written to sidecars and tool output |
| `COMFY_MAX_MEGAPIXELS` | `2.1` | larger requests are scaled down |
| `COMFY_TIMEOUT_MS` | `600000` | per ComfyUI job |
| `COMFY_INLINE_MAX_BYTES` | `3000000` | largest PNG returned in the tool result. `0` turns this off |

### Troubleshooting

| Symptom | Fix |
|---|---|
| `ComfyUI unreachable` | From the client machine, run `curl http://192.168.1.50:8188/system_stats`. If that fails, check the `--listen` flag, the firewall rule's RemoteAddress, that the network profile is Private, and that the PC is awake. |
| `rejected the workflow (400)` | The message lists the node errors. Usually a model filename doesn't match (section 1.2), or ComfyUI is too old for a node. |
| `unknown placeholders` | There's a typo in a `{{…}}` placeholder in the workflow JSON. |
| `needs workflows/edit.json` / `cutout.json` | Add that workflow, or generate without `refs` / transparency. |
| `The project root resolved to /` | The client started the server in `/`. Set `COMFY_PROJECT_ROOT`. |
| Images land in the wrong folder | Run `image_backend_status` to see the root, then set `COMFY_PROJECT_ROOT` (or `${workspaceFolder}` where the client supports it). |
| Tool call times out | Raise the client's tool timeout (section 4). The first call after a model swap is the slowest. |
| Image missing from the chat | It's over `COMFY_INLINE_MAX_BYTES`, or the client doesn't display image results. The file is on disk either way. |
| Garbled text in images | Expected with local models. Keep quoted copy short. |

## License

MIT. See [LICENSE](LICENSE).

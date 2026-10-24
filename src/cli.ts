#!/usr/bin/env node
import { parseArgs } from "node:util";
import { generate, resolveRoot, status, type Background } from "./comfy.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    prompt: { type: "string" },
    out: { type: "string" },
    size: { type: "string" },
    ref: { type: "string", multiple: true },
    background: { type: "string" },
    seed: { type: "string" },
    negative: { type: "string" },
  },
});

try {
  const root = resolveRoot();
  if (positionals[0] === "status") {
    console.log(await status(root));
  } else {
    if (!values.prompt || !values.out) throw new Error("--prompt and --out are required (or run `status`).");
    const r = await generate(
      {
        prompt: values.prompt,
        out: values.out,
        size: values.size,
        refs: values.ref,
        background: values.background as Background | undefined,
        seed: values.seed ? Number(values.seed) : undefined,
        negative: values.negative,
      },
      { root },
    );
    console.log(`IMAGE: ${r.out} (${r.width}x${r.height}, workflow ${r.workflow}, seed ${r.seed})`);
    for (const n of r.notes) console.log(`Note: ${n}`);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

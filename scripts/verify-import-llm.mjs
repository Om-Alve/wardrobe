#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { wardrobeImportApi } from "./import-job-api.mjs";

const root = await mkdtemp(path.join(tmpdir(), "wardrobe-import-llm-"));
const originalFetch = globalThis.fetch;
let handler;
let chatCalls = 0;
const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#53694e" } }).png().toBuffer();

async function invoke(route, method = "GET", data) {
  const req = Readable.from(data ? [Buffer.from(JSON.stringify(data))] : []);
  req.url = `/api/import${route}`;
  req.method = method;
  let status = 200;
  let bytes = Buffer.alloc(0);
  const res = {
    setHeader() {},
    set statusCode(value) { status = value; },
    end(value) { bytes = Buffer.isBuffer(value) ? value : Buffer.from(value || ""); },
  };
  await handler(req, res, () => { throw new Error(`Unexpected route: ${route}`); });
  return { status, body: JSON.parse(bytes.toString("utf8")) };
}

try {
  await mkdir(path.join(root, "data"));
  await writeFile(path.join(root, "data/model-reference.png"), png);
  globalThis.fetch = async (address, options) => {
    assert.equal(String(address), "http://localhost:11434/v1/chat/completions");
    assert.equal(options.headers.Authorization, undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.model, "local-vision-model");
    assert.equal(body.messages[0].content[1].type, "image_url");
    chatCalls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [{
      name: "Olive shirt", part: "upperbody", color: "#53694e", secondaryColor: null,
      tags: ["cotton"], boundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
    }] }) } }] }), { headers: { "Content-Type": "application/json" } });
  };
  const plugin = wardrobeImportApi({ env: {
    WARDROBE_LLM_BASE_URL: "http://localhost:11434/v1",
    WARDROBE_VISION_MODEL: "local-vision-model",
    OPENAI_IMAGE_API_KEY: "image-key",
  } });
  await plugin.configResolved({ root });
  plugin.configureServer({ middlewares: { use(value) { handler = value; } } });
  const config = await invoke("/config");
  assert.equal(config.body.ready, true);
  assert.equal(config.body.hasLlm, true);
  assert.equal(config.body.hasImageKey, true);
  const result = await invoke("/jobs", "POST", { imageDataUrl: `data:image/png;base64,${png.toString("base64")}` });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal(result.body.jobs[0].metadata.name, "Olive shirt");
  assert.equal(chatCalls, 1);
  console.log("Importer verified with a keyless local vision endpoint and a separate image key.");
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}

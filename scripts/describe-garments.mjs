#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fieldsForPart, PART_LABELS } from "./garment-attributes.mjs";
import { describeGarment } from "./import-job-api.mjs";
import { llmSettings } from "./llm-client.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
if (existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"));
const dataDir = path.resolve(root, process.env.WARDROBE_DATA_DIR || "data");
const libraryFile = path.join(dataDir, "library.json");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const everything = args.includes("--all");

if (args.some((arg) => !["--apply", "--all", "--help"].includes(arg))) {
  throw new Error("Usage: node scripts/describe-garments.mjs [--all] [--apply]");
}
if (args.includes("--help")) {
  console.log("Describes garments that have no attributes yet with the configured vision model and prints the results. Pass --all to redescribe every garment except ones you edited, and --apply to save the attributes to data/library.json.");
  process.exit(0);
}

const setting = (name, fallback = "") => process.env[name] || fallback;
const llm = llmSettings(setting);
if (!llm.configured) throw new Error("Configure WARDROBE_LLM_API_KEY or WARDROBE_LLM_BASE_URL in .env first.");
const library = JSON.parse(await readFile(libraryFile, "utf8"));
const pending = library.filter((item) => item.attributesSource !== "user" && (everything || !Object.keys(item.attributes || {}).length));
console.log(`Describing ${pending.length} of ${library.length} garments with ${llm.model}${apply ? "" : " (preview; pass --apply to save)"}.\n`);

const results = new Map();
const failures = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
  while (next < pending.length) {
    const item = pending[next++];
    try {
      const image = await readFile(path.join(dataDir, "imported", path.basename(new URL(item.image, "http://localhost").pathname)));
      results.set(item.id, await describeGarment({ ...llm, image, item }));
    } catch (error) {
      failures.push(`${item.name}: ${error.message}`);
    }
  }
}));

for (const item of pending.filter((entry) => results.has(entry.id))) {
  const attributes = results.get(item.id);
  const summary = fieldsForPart(item.part).filter((field) => attributes[field.key] !== undefined).map((field) => `${field.key}=${attributes[field.key]}`).join(" ");
  console.log(`${item.name} (${PART_LABELS[item.part]})\n  ${summary || "nothing recognized"}`);
}
if (failures.length) console.log(`\nFailed:\n  ${failures.join("\n  ")}`);

if (apply && results.size) {
  const latest = JSON.parse(await readFile(libraryFile, "utf8"));
  for (const item of latest) {
    if (!results.has(item.id) || item.attributesSource === "user") continue;
    item.attributes = results.get(item.id);
    item.attributesSource = "model";
  }
  const temporary = `${libraryFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(latest, null, 2)}\n`);
  await rename(temporary, libraryFile);
  console.log(`\nSaved attributes for ${results.size} garments to ${path.relative(root, libraryFile)}.`);
}
if (failures.length) process.exitCode = 1;

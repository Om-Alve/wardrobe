#!/usr/bin/env node
// Runs fixed briefs through the real stylist model on a copy of data/library.json and writes a report to data/evals/.
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { stylistApi } from "./stylist-api.mjs";

const BRIEFS = [
  { occasion: "Formal dinner", count: 3 },
  { occasion: "Birthday Party", count: 3 },
  { occasion: "everyday", count: 3 },
  { occasion: "Sightseeing", conditions: "Sunny, 32°C", count: 3 },
  { occasion: "Office", conditions: "Light rain, 11–17°C", count: 2 },
];

const root = fileURLToPath(new URL("../", import.meta.url));
if (existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"));
const dataDir = path.resolve(root, process.env.WARDROBE_DATA_DIR || "data");
const library = JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"));
const previous = existsSync(path.join(dataDir, "stylist.json")) ? JSON.parse(await readFile(path.join(dataDir, "stylist.json"), "utf8")).looks : [];
const byId = new Map(library.map((item) => [item.id, item]));
const workspace = await mkdtemp(path.join(tmpdir(), "wardrobe-live-eval-"));
const realFetch = globalThis.fetch;
let prompts = [];

async function call(route, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { url: `/api/stylist${route}`, method: "POST", headers: {} });
  let status = 200;
  let bytes = "";
  const res = {
    setHeader() {},
    get statusCode() { return status; },
    set statusCode(value) { status = value; },
    end(value) { bytes += value || ""; },
  };
  await handler(req, res, () => { throw new Error("Unmatched route"); });
  return { status, body: JSON.parse(bytes) };
}

const piece = (id) => {
  const item = byId.get(id);
  return item ? `${item.name}${item.attributes?.formality ? ` (formality ${item.attributes.formality})` : ""}` : id;
};
const lookLines = (look) => [`- **${look.name}**: ${look.garmentIds.map(piece).join(" + ")}`, `  ${look.reason}`];

let handler;
try {
  await mkdir(path.join(workspace, "data"));
  await copyFile(path.join(dataDir, "library.json"), path.join(workspace, "data", "library.json"));
  // Uses the saved profile, or one passed with --profile FILE to try a profile without saving it.
  const profileArg = process.argv.indexOf("--profile");
  const profileSource = profileArg > 0 ? path.resolve(process.argv[profileArg + 1]) : path.join(dataDir, "profile.json");
  if (existsSync(profileSource)) await copyFile(profileSource, path.join(workspace, "data", "profile.json"));
  globalThis.fetch = async (address, options) => {
    if (String(address).endsWith("/chat/completions")) prompts.push(JSON.parse(options.body).messages[0].content);
    return realFetch(address, options);
  };
  const plugin = stylistApi({ env: { WARDROBE_DATA_DIR: "data" } });
  await plugin.configResolved({ root: workspace });
  plugin.configureServer({ middlewares: { use(value) { handler = value; } } });

  const results = [];
  for (const brief of BRIEFS) {
    prompts = [];
    const started = Date.now();
    const { status, body } = await call("/suggest", { ...brief, selectedItemIds: library.map((item) => item.id) });
    const looks = status === 201 ? body : [];
    const items = looks.flatMap((look) => look.garmentIds);
    const result = {
      brief, status, seconds: Math.round((Date.now() - started) / 1000), modelCalls: prompts.length,
      retryFeedback: prompts.filter((prompt) => prompt.includes("Your previous answer was rejected: ")).map((prompt) => prompt.split("Your previous answer was rejected: ").at(-1).split(" Answer again.")[0]),
      candidates: (prompts.findLast((prompt) => prompt.includes("\nCandidates:\n"))?.match(/^L\d+:/gm) || []).length,
      gaps: looks[0]?.gaps || [],
      plan: looks[0]?.plan || null, itemDiversity: items.length ? Number((new Set(items).size / items.length).toFixed(2)) : null,
      looks, error: status === 201 ? null : body.error,
    };
    results.push(result);
    console.log(`${brief.occasion}${brief.conditions ? `, ${brief.conditions}` : ""}: HTTP ${status}, ${result.modelCalls} model call(s), ${result.seconds}s`);
  }

  const REVISION = "Make it a little dressier.";
  const everyday = results.find((result) => result.brief.occasion === "everyday")?.looks[0];
  let revision = null;
  if (everyday) {
    prompts = [];
    const { status, body } = await call(`/looks/${everyday.id}/revise`, { message: REVISION });
    const removed = everyday.garmentIds.filter((id) => !body.garmentIds?.includes(id));
    const added = (body.garmentIds || []).filter((id) => !everyday.garmentIds.includes(id));
    revision = { status, modelCalls: prompts.length, before: everyday, after: body, removed, added, singleChange: removed.length + added.length <= 2 && removed.length <= 1 && added.length <= 1 };
    console.log(`Revision: HTTP ${status}, ${removed.length} removed, ${added.length} added`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report = [`# Live outfit eval, ${new Date().toISOString()}`, "", `Model: ${process.env.WARDROBE_LLM_MODEL || "gpt-6-luna"}. Wardrobe: ${library.length} items, ${library.filter((item) => Object.keys(item.attributes || {}).length).length} described. Profile: ${existsSync(path.join(workspace, "data", "profile.json")) ? "yes" : "none"}.`, ""];
  for (const result of results) {
    const { brief } = result;
    report.push(`## ${brief.occasion}${brief.conditions ? ` (${brief.conditions})` : ""}`, "");
    report.push(`HTTP ${result.status}; ${result.modelCalls} model call(s); ${result.seconds}s; ${result.candidates} candidates shown; item diversity ${result.itemDiversity ?? "n/a"}.`);
    if (result.plan) report.push(`Plan: formality ${result.plan.formality.join("-")}, max warmth ${result.plan.maxWarmth ?? "none"}, outer layer ${result.plan.outerLayer}${result.plan.outerLayer === "skip" ? "" : ` up to warmth ${result.plan.layerMaxWarmth ?? "any"}`}${result.plan.include?.length ? `, include ${result.plan.include.map(piece).join(", ")}` : ""}${result.plan.exclude?.length ? `, exclude ${result.plan.exclude.map(piece).join(", ")}` : ""}.`);
    if (result.gaps.length) report.push(`Gaps: ${result.gaps.join(" ")}`);
    if (result.retryFeedback.length) report.push(`Retry feedback: ${result.retryFeedback.join(" | ")}`);
    if (result.error) report.push(`Error: ${result.error}`);
    report.push("", ...result.looks.flatMap(lookLines));
    const before = previous.filter((look) => look.occasion.toLowerCase() === brief.occasion.toLowerCase());
    if (before.length) report.push("", "Earlier looks for this occasion:", ...before.flatMap(lookLines));
    report.push("");
  }
  if (revision) {
    report.push(`## Revision: "${REVISION}"`, "", `HTTP ${revision.status}; ${revision.modelCalls} model call(s); ${revision.singleChange ? "single change" : "rebuilt"}: removed ${revision.removed.map(piece).join(", ") || "nothing"}, added ${revision.added.map(piece).join(", ") || "nothing"}.`, "", "Before:", ...lookLines(revision.before), "After:", ...(revision.after.garmentIds ? lookLines(revision.after) : [`- ${revision.after.error}`]), "");
  }
  await mkdir(path.join(dataDir, "evals"), { recursive: true });
  const file = path.join(dataDir, "evals", `live-${stamp}`);
  await writeFile(`${file}.md`, `${report.join("\n")}\n`);
  await writeFile(`${file}.json`, `${JSON.stringify({ results, revision }, null, 2)}\n`);
  console.log(`\nReport: ${path.relative(root, file)}.md`);
  if (results.some((result) => result.status !== 201)) process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  await rm(workspace, { recursive: true, force: true });
}

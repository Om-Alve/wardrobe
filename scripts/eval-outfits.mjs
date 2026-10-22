#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { stylistApi } from "./stylist-api.mjs";
import { relevantPalettes } from "./stylist-core.mjs";

const items = [
  { id: "tee", name: "White cotton T-shirt", part: "upperbody", color: "#efefea", tags: ["t-shirt"], attributes: { category: "tshirt", formality: 2, warmth: 1 } },
  { id: "hoodie", name: "Dark green hoodie", part: "upperbody", color: "#29332f", tags: ["hoodie"], attributes: { category: "hoodie", formality: 2, warmth: 2 } },
  { id: "dress-shirt", name: "Light blue dress shirt", part: "upperbody", color: "#d6e3f0", tags: ["dress shirt"], attributes: { category: "dress_shirt", formality: 4, warmth: 1, hem: "tails" } },
  { id: "cargo", name: "Tan cargo trousers", part: "lowerbody", color: "#c6a466", tags: ["cargo"], attributes: { category: "cargos", formality: 2, warmth: 1 } },
  { id: "relaxed-trousers", name: "Black relaxed trousers", part: "lowerbody", color: "#202024", tags: ["relaxed"], attributes: { category: "trousers", formality: 3, warmth: 1 } },
  { id: "formal-trousers", name: "Black formal trousers", part: "lowerbody", color: "#1a1a1d", tags: ["formal"], attributes: { category: "dress_trousers", formality: 4, warmth: 1 } },
  { id: "flannel", name: "Charcoal plaid flannel", part: "wholebody_up", color: "#38383b", tags: ["flannel"], attributes: { category: "overshirt", formality: 2, warmth: 2, pattern: "check" } },
  { id: "sneakers", name: "Running sneakers", part: "shoes", color: "#3b5262", tags: ["running"], attributes: { category: "athletic_sneakers", formality: 1, warmth: 1 } },
  { id: "bag", name: "Black sling bag", part: "accessories_up", color: "#242528", tags: ["sling bag"], attributes: { category: "bag", formality: 2 } },
  { id: "watch", name: "Silver watch", part: "accessories_up", color: "#c1c8cb", secondaryColor: "#0d3157", tags: ["watch"], attributes: { category: "watch", formality: 3 } },
];
const name = (id) => items.find((item) => item.id === id).name;
const PLAN = { maxWarmth: null, outerLayer: "optional", layerMaxWarmth: null, include: [], exclude: [] };
const FORMAL = { ...PLAN, formality: [4, 5] };
const HOT = { ...PLAN, formality: [1, 3], maxWarmth: 1, outerLayer: "skip" };
const CASUAL = { ...PLAN, formality: [1, 3] };

const workspace = await mkdtemp(path.join(tmpdir(), "wardrobe-outfit-eval-"));
const realFetch = globalThis.fetch;
let handler;
let answers = [];
let prompts = [];

async function invoke(route, method = "POST", body = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { url: `/api/stylist${route}`, method, headers: {} });
  let status = 200;
  let bytes = "";
  const res = {
    setHeader() {},
    get statusCode() { return status; },
    set statusCode(value) { status = value; },
    end(value) { bytes += value || ""; },
  };
  await handler(req, res, () => { throw new Error(`Unmatched route ${route}`); });
  return { status, body: JSON.parse(bytes) };
}

const suggest = (body) => invoke("/suggest", "POST", { selectedItemIds: items.map((item) => item.id), ...body });

function queue(...answerList) {
  answers = answerList;
  prompts = [];
}

// Reads the handles and candidate looks the server showed the model, so answers can refer to them by garment.
function handles(prompt) {
  return new Map([...prompt.matchAll(/^([TBOSA]\d+) \| [^|]+ \| ([^|]+?) \|/gm)].map((match) => [match[2], match[1]]));
}
function candidates(prompt) {
  const names = new Map([...handles(prompt)].map(([itemName, handle]) => [handle, itemName]));
  const section = prompt.split("\nCandidates:\n")[1]?.split("\n\n")[0] || "";
  return [...section.matchAll(/^(L\d+): ([^(\n]+?)(?: \((.*)\))?$/gm)].map((match) => ({
    label: match[1], names: match[2].split(" + ").map((handle) => names.get(handle)), notes: match[3] || "",
  }));
}
const plan = (value) => () => ({ plan: value });
const planWith = (value, change) => (prompt) => ({ plan: { ...value, ...change(handles(prompt)) } });
const pickBy = (choose, extras = []) => (prompt) => ({
  picks: choose(candidates(prompt)).map((entry) => ({
    look: entry.label, accessories: extras.map((itemName) => handles(prompt).get(itemName)), name: "Look", reason: "Chosen for the occasion.",
  })),
});
const pickWith = (...wanted) => pickBy((list) => [list.find((entry) => entry.names.length === wanted.length && wanted.every((itemName) => entry.names.includes(itemName)))]);

try {
  const dataDir = path.join(workspace, "data");
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify(items));
  const core = items.filter((item) => ["tee", "cargo"].includes(item.id));
  const baseline = relevantPalettes(core, 10);
  const [bag, watch] = items.filter((item) => item.part === "accessories_up");
  assert.deepEqual(relevantPalettes([...core, bag, watch], 10), baseline,
    "An unused bag or watch must not change the clothing palette shortlist.");
  assert.deepEqual(relevantPalettes([...core, bag], 10, "bag"), baseline,
    "Anchoring a bag must not turn its color into a clothing color.");

  globalThis.fetch = async (address, options) => {
    assert.match(String(address), /\/chat\/completions$/);
    const answer = answers.shift();
    assert.ok(answer, "The model received more requests than this case allows.");
    const prompt = JSON.parse(options.body).messages[0].content;
    prompts.push(prompt);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer(prompt)) } }] }),
      { headers: { "Content-Type": "application/json" } });
  };
  const plugin = stylistApi({ env: { WARDROBE_LLM_API_KEY: "eval-key", WARDROBE_DATA_DIR: "data" } });
  await plugin.configResolved({ root: workspace });
  plugin.configureServer({ middlewares: { use(value) { handler = value; } } });

  queue(plan(FORMAL), pickWith(name("dress-shirt"), name("formal-trousers")));
  const dinner = await suggest({ count: 3, occasion: "Formal dinner" });
  assert.equal(dinner.status, 201, JSON.stringify(dinner.body));
  const dinnerCandidates = candidates(prompts[1]);
  assert.equal(dinnerCandidates.length, 1, "Only the dress shirt and formal trousers fit a formality 4-5 plan.");
  assert.doesNotMatch(prompts[1], /Dark green hoodie|Tan cargo trousers|Black relaxed trousers/, "Pieces outside the plan never reach the model.");
  assert.match(prompts[1], /Gaps: No shoes fit formality 3-5.*"Running sneakers"/, "The model is told that no shoes fit, and which shoes exist.");
  assert.equal(dinner.body.length, 1, "When fewer distinct looks fit than requested, the stylist returns fewer instead of padding.");
  assert.deepEqual(dinner.body[0].garmentIds, ["dress-shirt", "formal-trousers"]);
  assert.deepEqual(dinner.body[0].plan.formality, [4, 5], "The look keeps the plan it was built from.");
  assert.equal(dinner.body[0].palette.id, relevantPalettes(items.filter((item) => dinner.body[0].garmentIds.includes(item.id)), 1)[0].id,
    "The shown Wada palette must be chosen for the actual clothes in the look.");

  queue(plan(HOT), pickBy((list) => list.slice(0, 2)));
  const walk = await suggest({ count: 2, occasion: "Sightseeing", conditions: "Sunny, 32°C", selectedItemIds: ["tee", "hoodie", "cargo", "relaxed-trousers", "flannel", "sneakers"] });
  assert.equal(walk.status, 201, JSON.stringify(walk.body));
  assert.doesNotMatch(prompts[1].split("\nCandidates:\n")[1], /O\d/, "A plan that skips layers produces no layered candidates.");
  assert.ok(candidates(prompts[1]).every((entry) => !entry.names.includes(name("hoodie"))), "Tops warmer than the planned maximum are left out.");
  assert.deepEqual(walk.body.map((look) => look.garmentIds[1]).sort(), ["cargo", "relaxed-trousers"], "Two looks use different bottoms when the candidates allow it.");

  queue(plan({ ...PLAN, formality: [2, 3] }), pickBy((list) => list.slice(0, 1)));
  await suggest({ count: 1, occasion: "Sightseeing" });
  assert.ok(candidates(prompts[1]).some((entry) => entry.names.includes("Running sneakers")),
    "Without a shoe range, shoes one step below the clothes still fit.");
  queue(plan({ ...PLAN, formality: [2, 3], shoeFormality: [3, 4] }), pickBy((list) => list.slice(0, 1)));
  await suggest({ count: 1, occasion: "Smart casual" });
  assert.match(prompts[1], /Gaps: No shoes fit formality 3-4/, "A shoe range from the plan overrides that allowance.");

  queue(() => ({ looks: [] }), plan(CASUAL), pickBy((list) => list.slice(0, 1)));
  const replanned = await suggest({ count: 1, occasion: "Errands" });
  assert.equal(replanned.status, 201, JSON.stringify(replanned.body));
  assert.match(prompts[1], /Your previous answer was rejected: Return "plan"/, "An answer without a plan is sent back with the reason.");

  queue(plan(CASUAL), () => ({ picks: [{ look: "L999", name: "Missing", reason: "Not listed." }] }), pickBy((list) => list.slice(0, 1)));
  const repicked = await suggest({ count: 1, occasion: "Errands" });
  assert.equal(repicked.status, 201, JSON.stringify(repicked.body));
  assert.match(prompts[2], /L999 is not on the list/, "A pick outside the shortlist is sent back with the reason.");

  queue(planWith(CASUAL, (handleOf) => ({ exclude: [handleOf.get(name("cargo"))] })), pickBy((list) => list.slice(0, 1)));
  const noCargo = await suggest({ count: 1, occasion: "Errands", brief: "Anything but the cargos." });
  assert.equal(noCargo.status, 201, JSON.stringify(noCargo.body));
  assert.ok(candidates(prompts[1]).every((entry) => !entry.names.includes(name("cargo"))), "Pieces the plan excludes from the brief are filtered out.");

  queue(plan(CASUAL), pickWith(name("tee"), name("cargo"), name("sneakers")));
  const everyday = await suggest({ count: 1, occasion: "Errands", selectedItemIds: ["tee", "hoodie", "cargo", "relaxed-trousers", "sneakers"] });
  assert.equal(everyday.status, 201, JSON.stringify(everyday.body));
  const worn = await invoke(`/looks/${everyday.body[0].id}/wear`);
  assert.equal(worn.status, 201, JSON.stringify(worn.body));
  const disliked = await invoke(`/looks/${everyday.body[0].id}/verdict`, "POST", { verdict: "down" });
  assert.equal(disliked.body.verdict, "down");
  queue(plan(CASUAL), pickBy((list) => list.slice(0, 1)));
  await suggest({ count: 1, occasion: "Errands", selectedItemIds: ["tee", "hoodie", "cargo", "relaxed-trousers", "sneakers"] });
  const after = candidates(prompts[1]);
  assert.ok(!after.some((entry) => entry.names.includes(name("tee")) && entry.names.includes(name("cargo"))), "A thumbs-down removes that top and bottom pairing from later suggestions.");
  assert.ok(after.some((entry) => entry.names.includes(name("tee")) && /"White cotton T-shirt"[^;]* worn today/.test(entry.notes)), "Pieces worn today are flagged to the model.");
  const state = (await invoke("/state", "GET")).body;
  assert.equal(state.wears.length, 1);
  assert.equal((await invoke(`/wears/${state.wears[0].id}`, "DELETE")).status, 200, "A logged wear can be undone.");

  queue(plan(CASUAL), pickWith(name("hoodie"), name("relaxed-trousers"), name("sneakers")));
  const toRevise = (await suggest({ count: 1, occasion: "Errands", selectedItemIds: ["tee", "hoodie", "cargo", "relaxed-trousers", "sneakers"] })).body[0];
  queue((prompt) => {
    const handleOf = handles(prompt);
    const option = prompt.match(new RegExp(`^(V\\d+): swap ${handleOf.get(name("hoodie"))} for ${handleOf.get(name("tee"))}$`, "m"));
    return { change: option[1], pieces: null, name: "Lighter errands", reason: "The tee is lighter." };
  });
  const revised = await invoke(`/looks/${toRevise.id}/revise`, "POST", { message: "Something lighter on top." });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.deepEqual(revised.body.garmentIds, ["tee", "relaxed-trousers", "sneakers"], "A single-change revision swaps one piece and keeps the rest.");
  const swaps = JSON.parse(await readFile(path.join(dataDir, "stylist.json"), "utf8")).swaps;
  assert.deepEqual(swaps.map(({ out, in: added }) => [out, added]), [["hoodie", "tee"]], "The swap is recorded as a preference.");

  console.log("Outfit evals passed: plan filtering with gaps, shoe range and its allowance, fewer looks instead of padding, warmth and layer plan, distinct bottoms, plan and pick retries, brief exclusions, thumbs-down exclusion, worn-today notes, undoing a wear, single-swap revision, and chosen-clothes Wada reference.");
} finally {
  globalThis.fetch = realFetch;
  await rm(workspace, { recursive: true, force: true });
}

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

  const purple = (prompt) => ({ picks: [{ look: candidates(prompt)[0].label, accessories: [], name: "Look", reason: "A purple accent lifts it." }] });
  queue(plan(CASUAL), purple, purple);
  const misdescribed = await suggest({ count: 1, occasion: "Errands", selectedItemIds: ["tee", "cargo", "sneakers"] });
  assert.equal(misdescribed.status, 201, "A reason that names a color the look lacks gets one correction, then the look is kept rather than failing the request.");
  assert.match(prompts[2], /L1 mentions purple, which is not in the look/, "The correction request names the unsupported color.");

  queue(plan(FORMAL), (prompt) => ({ picks: [{ look: candidates(prompt)[0].label, accessories: [], name: "Dinner", reason: "No dress shoes, so the blue running sneakers stay home." }] }));
  await suggest({ count: 1, occasion: "Formal dinner" });
  assert.equal(prompts.length, 2, "Colors of pieces named in a gap are fair to mention.");

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

  const occasionsBefore = (await invoke("/buy-next", "GET")).body;
  assert.ok(occasionsBefore.occasions.includes("errands"), "Occasions to review default to the ones the wearer has asked for.");
  const piece = (name, part, color, attributes, why = "") => ({ name, part, color, attributes, why });
  queue(
    () => ({ plans: [{ occasion: "everyday", plan: { ...PLAN, formality: [1, 3], shoeFormality: [1, 3] } }, { occasion: "formal dinner", plan: { ...PLAN, formality: [4, 5], shoeFormality: [4, 5] } }] }),
    (prompt) => ({ candidates: [
      piece("Second running sneakers", "shoes", "#3b5262", { category: "athletic_sneakers", formality: 1, warmth: 1 }),
      piece("Grey dress trousers", "lowerbody", "#55585c", { category: "dress_trousers", formality: 4, warmth: 1 }, `Pairs with ${handles(prompt).get(name("dress-shirt"))}.`),
      piece("Dark brown derbies", "shoes", "#4a3322", { category: "dress_shoes", formality: 4, warmth: 1 }),
      piece("Black loafers", "shoes", "#141414", { category: "loafers", formality: 4, warmth: 1 }),
      piece("Mystery top", "upperbody", "#ffffff", { category: "top" }),
      piece("Pale blue dress shirt", "upperbody", "#d2e0ee", { category: "dress_shirt", formality: 4, warmth: 1 }),
      piece("Grey canvas sneakers", "shoes", "#8a8d90", { category: "casual_sneakers", formality: 2, warmth: 1 }),
      piece("White dress shirt", "upperbody", "#f8f8f4", { category: "dress_shirt", formality: 4, warmth: 1 }),
    ] }),
  );
  const review = await invoke("/buy-next", "POST", { occasions: ["Everyday", "Formal dinner"] });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.match(prompts[1], /formal dinner: plan formality 4-5.*complete outfits now: 0; gaps: No shoes fit/, "Candidates are proposed knowing each occasion's coverage and gaps.");
  const byName = Object.fromEntries(review.body.results.map((result) => [result.item.name, result]));
  assert.equal(review.body.coverage.find((entry) => entry.occasion === "formal dinner").outfits, 0);
  assert.equal(byName["Dark brown derbies"].step, 1, "Shoes that give a first formal outfit come first.");
  assert.equal(byName["Grey dress trousers"].step, 2, "Trousers that only help once dress shoes exist come after them.");
  assert.equal(byName["Grey dress trousers"].alone.added, 0);
  assert.equal(byName["Black loafers"].alternativeTo, "Dark brown derbies", "A second pair that only repeats the first pick's job is shown as its alternative.");
  assert.equal(byName["Second running sneakers"].similarTo, "Running sneakers", "A repeat of owned shoes is pointed out as a twin.");
  assert.equal(byName["Grey canvas sneakers"].step, null);
  assert.equal(byName["Grey canvas sneakers"].alternativeTo, null, "A piece that adds nothing even alone is simply covered.");
  assert.equal(byName["Grey canvas sneakers"].note, "Shoes you own already complete the outfits it could join.", "A covered piece explains what it counted instead of the model's pitch.");
  assert.ok(!byName["Mystery top"], "Proposals without formality and warmth are dropped.");
  assert.equal(byName["Pale blue dress shirt"].similarTo, "Light blue dress shirt", "A near-twin of an owned piece is shown as similar rather than ranked.");
  assert.equal(byName["Pale blue dress shirt"].step, null);
  assert.ok(!byName["White dress shirt"].similarTo, "A white dress shirt is not a twin of a light blue one, even though both are pale.");
  assert.equal(byName["Grey dress trousers"].why, `Pairs with ${name("dress-shirt")}.`, "Handles in explanations become garment names.");
  assert.deepEqual((await invoke("/buy-next", "GET")).body.last.results.map((result) => result.item.name), review.body.results.map((result) => result.item.name), "The last review is kept.");

  const blackTie = () => ({ plans: [{ occasion: "black tie", plan: { ...PLAN, formality: [5, 5], shoeFormality: [5, 5] } }] });
  const tuxShirt = piece("Tuxedo shirt", "upperbody", "#f8f8f4", { category: "dress_shirt", formality: 5, warmth: 1 });
  const tuxTrousers = piece("Tuxedo trousers", "lowerbody", "#1d2840", { category: "dress_trousers", formality: 5, warmth: 1 });
  queue(blackTie, () => ({ candidates: [tuxShirt, tuxTrousers, piece("Patent oxfords", "shoes", "#141414", { category: "dress_shoes", formality: 5, warmth: 1 }), piece("Linen shorts", "lowerbody", "#d8c7a6", { category: "shorts", formality: 1, warmth: 0 })] }));
  const tie = Object.fromEntries((await invoke("/buy-next", "POST", { occasions: ["Black tie"] })).body.results.map((result) => [result.item.name, result]));
  assert.deepEqual(["Tuxedo shirt", "Tuxedo trousers", "Patent oxfords"].map((piece) => tie[piece].step), [1, 1, 1], "Pieces that only help together are recommended as one step.");
  assert.deepEqual([...tie["Tuxedo shirt"].together].sort(), ["Patent oxfords", "Tuxedo trousers"]);
  assert.equal(tie["Tuxedo shirt"].added, 1);
  assert.equal(tie["Linen shorts"].note, "It does not fit the plan for any of these occasions.");
  queue(blackTie, () => ({ candidates: [tuxShirt, tuxTrousers] }));
  const incomplete = (await invoke("/buy-next", "POST", { occasions: ["Black tie"] })).body.results.find((result) => result.item.name === "Tuxedo shirt");
  assert.match(incomplete.note, /^It would need other pieces too\. For black tie: No bottoms dressy enough; the closest you have is "Black formal trousers"\. No shoes dressy enough; you have "Running sneakers"\./, "A piece that cannot complete an outfit yet says what else is missing, not that it is covered.");

  queue(planWith(CASUAL, (handleOf) => ({ include: [handleOf.get(name("hoodie"))] })), pickBy((list) => list.slice(0, 1)));
  const anchored = await suggest({ count: 1, occasion: "Errands", anchorId: "tee", selectedItemIds: ["tee", "hoodie", "cargo", "relaxed-trousers", "sneakers"] });
  assert.equal(anchored.status, 201, JSON.stringify(anchored.body));
  assert.match(prompts[0], /Anchor piece, worn in every look: T\d+ White cotton T-shirt/, "The plan is told about the anchor.");
  assert.ok(candidates(prompts[1]).every((entry) => entry.names.includes(name("tee"))), "The anchor stays in every candidate even when the plan asks for another top.");

  queue(plan(CASUAL), pickBy((list) => list.slice(0, 1)));
  const doomed = (await suggest({ count: 1, occasion: "Errands", selectedItemIds: ["hoodie", "relaxed-trousers", "sneakers"] })).body[0];
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify(items.filter((item) => item.id !== doomed.garmentIds[1])));
  queue();
  const stale = await invoke(`/looks/${doomed.id}/revise`, "POST", { message: "Something lighter." });
  assert.equal(stale.status, 409, "A look whose pieces are gone cannot be revised.");
  assert.equal(prompts.length, 0, "No model call is spent on it.");
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify(items));

  queue(plan(FORMAL), pickBy((list) => list.slice(0, 1)));
  const lone = (await suggest({ count: 1, occasion: "Formal dinner", selectedItemIds: ["dress-shirt", "formal-trousers"] })).body[0];
  await invoke(`/looks/${lone.id}/verdict`, "POST", { verdict: "down" });
  queue(plan(FORMAL), pickBy((list) => list.slice(0, 1)));
  const offeredAgain = await suggest({ count: 1, occasion: "Formal dinner", selectedItemIds: ["dress-shirt", "formal-trousers"] });
  assert.equal(offeredAgain.status, 201, "Turning down the only fitting look does not leave the request with nothing.");
  assert.match(offeredAgain.body[0].gapNotes.join(" "), /turned down/);

  queue(plan(CASUAL), (prompt) => ({ picks: [{ look: candidates(prompt)[0].label, accessories: [], name: "Drinks", reason: "Easy enough for a wine bar." }] }));
  await suggest({ count: 1, occasion: "Drinks", selectedItemIds: ["hoodie", "relaxed-trousers", "sneakers"] });
  assert.equal(prompts.length, 2, "Words like wine are not taken as color claims.");

  const many = (part, count, extra = {}) => Array.from({ length: count }, (_, index) => ({
    id: `${part}-${index}`, name: `${part} ${index}`, part, color: `#${(40 + index * 6).toString(16).padStart(2, "0")}6070`, tags: [], attributes: { formality: 2, warmth: 1, ...extra },
  }));
  const big = [...many("upperbody", 30), ...many("lowerbody", 20), ...many("wholebody_up", 10), ...many("shoes", 20)];
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify(big));
  queue(plan(CASUAL), pickBy((list) => list.slice(0, 1)));
  const crowded = await suggest({ count: 1, occasion: "Errands", selectedItemIds: big.map((item) => item.id) });
  assert.equal(crowded.status, 201, "A wardrobe with over a hundred thousand combinations still gets suggestions.");
  assert.ok(candidates(prompts[1]).length <= 20);
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify(items));

  // The lookbook runs on its own data folder so earlier verdicts do not change which outfits exist.
  const mainHandler = handler;
  await mkdir(path.join(workspace, "lookbook-data"));
  await writeFile(path.join(workspace, "lookbook-data", "library.json"), JSON.stringify(items));
  const lookbookPlugin = stylistApi({ env: { WARDROBE_LLM_API_KEY: "eval-key", WARDROBE_DATA_DIR: "lookbook-data" } });
  await lookbookPlugin.configResolved({ root: workspace });
  lookbookPlugin.configureServer({ middlewares: { use(value) { handler = value; } } });
  const outfitList = (prompt) => {
    const names = new Map([...handles(prompt)].map(([itemName, handle]) => [handle, itemName]));
    return [...prompt.split("\nOutfits:\n")[1].matchAll(/^(K\d+): ([^(\n]+?)(?: \((.*)\))?$/gm)].map((match) => ({ id: match[1], names: match[2].split(" + ").map((handle) => names.get(handle)), note: match[3] || "" }));
  };
  const sortOutfits = (skipOne) => (prompt) => ({
    outfits: outfitList(prompt).filter((outfit, index) => !(skipOne && index === 0)).map((outfit) => ({
      id: outfit.id,
      genre: outfit.names.includes(name("hoodie")) && outfit.names.includes(name("formal-trousers")) ? "skip" : outfit.names.includes(name("formal-trousers")) ? "Dressy" : "Casual",
      name: outfit.names.includes(name("dress-shirt")) && outfit.names.includes(name("cargo")) ? "Purple haze" : "Named look",
    })),
  });
  queue(
    () => ({ genres: [{ name: "Casual", description: "Everyday." }, { name: "Athleisure", description: "Sporty." }, { name: "Dressy", description: "Evenings." }] }),
    sortOutfits(true),
    sortOutfits(false),
  );
  const built = await invoke("/lookbook", "POST");
  assert.equal(built.status, 200, JSON.stringify(built.body));
  const book = built.body.lookbook;
  assert.equal(book.outfits.length, 18, "Every top and bottom, with and without the layer, becomes an outfit.");
  assert.match(prompts[2], /An earlier answer missed these outfits/, "Outfits the model missed are asked about again.");
  assert.deepEqual(book.genres.map((genre) => genre.name), ["Casual", "Dressy"], "Genres that end up empty are dropped.");
  assert.ok(book.outfits.filter((outfit) => outfit.genre === "skip").length === 2, "Combinations the model leaves out are kept as left out, not discarded.");
  const formalNoShoes = book.outfits.find((outfit) => outfit.ids.length === 2 && outfit.ids.includes("dress-shirt") && outfit.ids.includes("formal-trousers"));
  assert.equal(formalNoShoes.note, "Needs dressier shoes", "Running sneakers are not paired with dress clothes; the outfit says what it needs.");
  assert.ok(book.outfits.filter((outfit) => outfit.ids.includes("dress-shirt") && outfit.ids.includes("cargo")).every((outfit) => outfit.name !== "Purple haze"), "A name claiming a color the outfit lacks is replaced.");
  assert.equal((await invoke("/lookbook", "GET")).body.stale, false);
  await writeFile(path.join(workspace, "lookbook-data", "library.json"), JSON.stringify([...items, { ...items[0], id: "tee-2", name: "Grey tee", color: "#8a8d90" }]));
  assert.equal((await invoke("/lookbook", "GET")).body.stale, true, "Adding a piece marks the lookbook out of date.");
  await writeFile(path.join(workspace, "lookbook-data", "library.json"), JSON.stringify(items));

  const favorite = book.outfits.find((outfit) => outfit.genre === "Casual");
  const savedOnce = await invoke("/outfits/save", "POST", { garmentIds: favorite.ids, name: favorite.name, genre: "Casual", reason: "Everyday." });
  assert.equal(savedOnce.status, 201, JSON.stringify(savedOnce.body));
  assert.ok(savedOnce.body.savedAt);
  assert.equal((await invoke("/outfits/save", "POST", { garmentIds: favorite.ids, name: favorite.name })).body.id, savedOnce.body.id, "Saving the same outfit twice keeps one saved look.");
  const dull = book.outfits.find((outfit) => outfit.genre === "Casual" && outfit !== favorite);
  assert.equal((await invoke("/outfits/hide", "POST", { garmentIds: dull.ids })).status, 200);
  const afterHide = (await invoke("/lookbook", "GET")).body.lookbook.outfits;
  assert.ok(!afterHide.some((outfit) => [...outfit.ids].sort().join() === [...dull.ids].sort().join()), "A hidden outfit leaves the lookbook.");
  queue(plan({ ...PLAN, formality: [1, 5], shoeFormality: [1, 5] }), pickBy((list) => list.slice(0, 1)));
  await suggest({ count: 1, occasion: "Anything" });
  assert.ok(!candidates(prompts[1]).some((entry) => [...entry.names].sort().join() === dull.ids.map(name).sort().join()), "The stylist avoids a hidden outfit too.");
  const wore = await invoke("/wears", "POST", { garmentIds: favorite.ids });
  assert.equal(wore.status, 201);
  assert.equal(wore.body.lookId, null, "An outfit can be logged as worn without saving it first.");
  handler = mainHandler;

  const profileFile = path.join(dataDir, "profile.json");
  await writeFile(profileFile, JSON.stringify({ enabled: true, contrast: "high", hairLightness: "dark", avoidedColors: ["olive"], fit: "relaxed" }));
  queue(plan(CASUAL), pickBy((list) => list.slice(0, 1)));
  await suggest({ count: 1, occasion: "Errands", selectedItemIds: ["tee", "hoodie", "cargo", "relaxed-trousers", "sneakers"] });
  assert.match(prompts[0], /Wearer: high personal contrast \(dark hair\)/, "The plan sees the wearer's profile.");
  assert.match(prompts[1], /Wearer: .*Prefers relaxed fits/, "The pick sees the wearer's profile.");
  const contrastNotes = candidates(prompts[1]).map((entry) => entry.notes).join(" ");
  assert.match(contrastNotes, /suits your high contrast/, "Looks with light-against-dark contrast are noted as suiting the wearer.");
  assert.match(contrastNotes, /lower contrast than your coloring/, "Low-contrast looks are noted for a high-contrast wearer.");
  await writeFile(profileFile, JSON.stringify({ enabled: false, contrast: "high" }));
  queue(plan(CASUAL), pickBy((list) => list.slice(0, 1)));
  await suggest({ count: 1, occasion: "Errands" });
  assert.doesNotMatch(prompts.join("\n"), /Wearer:|contrast than your coloring|suits your high contrast/, "A switched-off profile changes nothing.");
  await rm(profileFile);

  const efforts = [];
  globalThis.fetch = async (address, options) => {
    const body = JSON.parse(options.body);
    efforts.push(body.reasoning_effort ?? null);
    if (body.reasoning_effort) {
      return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort'." } }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const prompt = body.messages[0].content;
    const answer = prompt.startsWith("You are a practical personal stylist planning") ? plan(CASUAL)() : pickBy((list) => list.slice(0, 1))(prompt);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { headers: { "Content-Type": "application/json" } });
  };
  const tuned = stylistApi({ env: { WARDROBE_LLM_API_KEY: "eval-key", WARDROBE_DATA_DIR: "data", WARDROBE_REASONING_EFFORT: "none" } });
  await tuned.configResolved({ root: workspace });
  tuned.configureServer({ middlewares: { use(value) { handler = value; } } });
  const fallback = await suggest({ count: 1, occasion: "Errands" });
  assert.equal(fallback.status, 201, JSON.stringify(fallback.body));
  assert.deepEqual(efforts, ["none", null, "none", null], "A provider that rejects the reasoning setting gets each request again without it.");

  console.log("Outfit evals passed: plan filtering with gaps, shoe range and its allowance, fewer looks instead of padding, warmth and layer plan, distinct bottoms, plan and pick retries, brief exclusions, thumbs-down exclusion, worn-today notes, undoing a wear, single-swap revision, reasoning setting fallback, color claims in reasons, wearer profile in prompts and ranking, what-to-buy order with alternatives, owned twins, and counted reasons, pieces that only work together, anchor over plan includes, stale revisions, re-offered turned-down looks, non-color words, a very large wardrobe, the lookbook with genres, left-out outfits, staleness, saving, hiding, and wears, and chosen-clothes Wada reference.");
} finally {
  globalThis.fetch = realFetch;
  await rm(workspace, { recursive: true, force: true });
}

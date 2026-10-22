// Builds every valid look from the wardrobe, then narrows them to a varied shortlist for the model to choose from.
// Hard filters come only from the model's plan, the user's anchor, and the user's own rejections;
// style rules below only rank looks, so the model still makes the final call.
import { signature } from "./feedback.mjs";
import { colorProfile, lab, normalizeAttributes, PART_LABELS } from "./garment-attributes.mjs";

const PREFIX = { upperbody: "T", lowerbody: "B", wholebody_up: "O", shoes: "S", accessories_up: "A" };
const PART_ORDER = Object.keys(PREFIX);
const LAYER_PLANS = new Set(["needed", "optional", "skip"]);
const SHORTLIST_SIZE = 20;
// Above this many combinations, shoe and layer options are trimmed to those closest to the plan.
const MAX_LOOKS = 20000;

export function assignHandles(items) {
  const handleOf = new Map();
  const itemOf = new Map();
  const counters = {};
  const sorted = [...items].sort((a, b) => PART_ORDER.indexOf(a.part) - PART_ORDER.indexOf(b.part) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  for (const item of sorted) {
    counters[item.part] = (counters[item.part] || 0) + 1;
    const handle = `${PREFIX[item.part] || "X"}${counters[item.part]}`;
    handleOf.set(item.id, handle);
    itemOf.set(handle, item);
  }
  return { handleOf, itemOf, sorted };
}

const warmth = (value, label) => {
  if (value === null || value === undefined || value === "null") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 4) throw new Error(`In "plan", give "${label}" as an integer from 0 to 4, or null.`);
  return number;
};

const range = (value, label) => {
  const levels = Array.isArray(value) ? value.map(Number) : [];
  if (levels.length !== 2 || levels.some((level) => !Number.isInteger(level) || level < 1 || level > 5) || levels[0] > levels[1]) {
    throw new Error(`Return "plan" with "${label}" as [lowest, highest] integers from 1 to 5.`);
  }
  return levels;
};

export function validatePlan(value, itemOf) {
  const plan = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const formality = range(plan.formality, "formality");
  // Without a shoe range, shoes may sit one step below the clothes, the usual allowance for shoes.
  const shoeFormality = plan.shoeFormality === undefined || plan.shoeFormality === null
    ? [Math.max(1, formality[0] - 1), formality[1]]
    : range(plan.shoeFormality, "shoeFormality");
  if (!LAYER_PLANS.has(plan.outerLayer)) throw new Error('In "plan", set "outerLayer" to "needed", "optional", or "skip".');
  const handles = (key) => {
    const list = plan[key] === undefined || plan[key] === null ? [] : plan[key];
    if (!Array.isArray(list)) throw new Error(`In "plan", give "${key}" as a list of item handles.`);
    const unknown = list.filter((handle) => !itemOf.has(handle));
    if (unknown.length) throw new Error(`In "plan", "${key}" names unknown handles: ${unknown.join(", ")}.`);
    return [...new Set(list)].map((handle) => itemOf.get(handle).id);
  };
  const include = handles("include");
  const exclude = handles("exclude").filter((id) => !include.includes(id));
  return {
    formality,
    shoeFormality,
    maxWarmth: warmth(plan.maxWarmth, "maxWarmth"),
    outerLayer: plan.outerLayer,
    layerMaxWarmth: warmth(plan.layerMaxWarmth, "layerMaxWarmth"),
    include,
    exclude,
  };
}

export function describePlan(plan) {
  return `formality ${plan.formality.join("-")}; shoes ${plan.shoeFormality.join("-")}; base pieces up to warmth ${plan.maxWarmth ?? "any"}; outer layer ${plan.outerLayer}${plan.outerLayer === "skip" ? "" : ` up to warmth ${plan.layerMaxWarmth ?? "any"}`}`;
}

// Lists every top, bottom, optional layer, and shoe combination that fits the plan.
export function enumerateLooks(items, plan, { anchorId = "", rejectedSets = new Set(), rejectedPairs = new Set() } = {}) {
  const attributes = new Map(items.map((item) => [item.id, normalizeAttributes(item.attributes, item.part)]));
  const required = new Set([anchorId, ...plan.include].filter(Boolean));
  const excluded = new Set(plan.exclude.filter((id) => !required.has(id)));
  const miss = (item, maxWarmth) => {
    const { formality, warmth: level } = attributes.get(item.id);
    const [lowest, highest] = item.part === "shoes" ? plan.shoeFormality : plan.formality;
    const below = formality === undefined ? 0 : Math.max(0, lowest - formality, formality - highest);
    const over = maxWarmth === null || level === undefined ? 0 : Math.max(0, level - maxWarmth);
    return below + over;
  };
  const names = (list) => list.map((item) => `"${item.name}"`).join(", ");
  const limits = (maxWarmth, [lowest, highest] = plan.formality) => `formality ${lowest}-${highest}${maxWarmth === null ? "" : ` and warmth up to ${maxWarmth}`}`;
  const gaps = [];
  // The same gaps in plain words for the page; the model gets the exact ranges above.
  const notes = [];
  const shortfall = (list, maxWarmth, [lowest, highest] = plan.formality) => {
    const levels = list.map((item) => attributes.get(item.id));
    if (levels.length && levels.every(({ formality }) => formality !== undefined && formality < lowest)) return "dressy enough";
    if (levels.length && levels.every(({ formality }) => formality !== undefined && formality > highest)) return "casual enough";
    if (maxWarmth !== null && levels.length && levels.every(({ warmth: level }) => level !== undefined && level > maxWarmth)) return "light enough for the weather";
    return "right for this";
  };
  const owned = (list) => list.length > 2 ? `"${list[0].name}" and ${list.length - 1} more` : list.map((item) => `"${item.name}"`).join(" and ");
  // Pieces a reason may name without wearing them: ones the request ruled out and ones a gap points to.
  const mentioned = items.filter((item) => excluded.has(item.id));
  // Slots filled with the closest pieces because nothing fit; looks built on them are stand-ins, not complete outfits.
  const relaxed = new Set();
  const choose = (part, maxWarmth) => {
    const pool = items.filter((item) => item.part === part && !excluded.has(item.id));
    // The anchor alone holds its slot; pieces the plan asks for share a slot only with each other.
    const anchored = pool.filter((item) => item.id === anchorId);
    if (anchored.length) return { fitting: anchored, any: true };
    const pinned = pool.filter((item) => required.has(item.id));
    if (pinned.length) return { fitting: pinned, any: true };
    const fitting = pool.filter((item) => miss(item, maxWarmth) === 0);
    return { fitting, pool };
  };

  let { fitting: tops, pool: allTops } = choose("upperbody", plan.maxWarmth);
  let { fitting: bottoms, pool: allBottoms } = choose("lowerbody", plan.maxWarmth);
  for (const [label, list, pool, assign] of [["tops", tops, allTops, (value) => { tops = value; }], ["bottoms", bottoms, allBottoms, (value) => { bottoms = value; }]]) {
    if (list.length || !pool?.length) continue;
    const best = Math.min(...pool.map((item) => miss(item, plan.maxWarmth)));
    const closest = pool.filter((item) => miss(item, plan.maxWarmth) === best);
    assign(closest);
    relaxed.add(label);
    gaps.push(`No ${label} fit ${limits(plan.maxWarmth)}; the closest ${closest.length === 1 ? "is" : "are"} ${names(closest)}.`);
    notes.push(`No ${label} ${shortfall(pool, plan.maxWarmth)}; the closest you have ${closest.length === 1 ? "is" : "are"} ${owned(closest)}.`);
  }

  const layerChoice = choose("wholebody_up", plan.layerMaxWarmth);
  let layers;
  if (layerChoice.any) layers = layerChoice.fitting;
  else if (plan.outerLayer === "skip") layers = [null];
  else if (plan.outerLayer === "needed" && layerChoice.fitting.length) layers = layerChoice.fitting;
  else {
    layers = [null, ...layerChoice.fitting];
    if (plan.outerLayer === "needed") {
      gaps.push(`The conditions call for an outer layer, but none fits ${limits(plan.layerMaxWarmth)}${layerChoice.pool.length ? `; the wardrobe has ${names(layerChoice.pool)}` : ""}.`);
      notes.push(layerChoice.pool.length
        ? `No outer layer ${shortfall(layerChoice.pool, plan.layerMaxWarmth)}; you have ${owned(layerChoice.pool)}.`
        : "No outer layer, and this calls for one.");
      mentioned.push(...layerChoice.pool);
    }
  }

  const shoeChoice = choose("shoes", plan.maxWarmth);
  let shoes = shoeChoice.fitting;
  if (!shoes.length) {
    shoes = [null];
    if (shoeChoice.pool?.length) {
      gaps.push(`No shoes fit ${limits(plan.maxWarmth, plan.shoeFormality)}, so looks leave shoes out; the wardrobe has ${names(shoeChoice.pool)}.`);
      notes.push(`No shoes ${shortfall(shoeChoice.pool, plan.maxWarmth, plan.shoeFormality)}; you have ${owned(shoeChoice.pool)}.`);
      mentioned.push(...shoeChoice.pool);
    }
  }

  if (tops.length * bottoms.length * layers.length * shoes.length > MAX_LOOKS) {
    const nearest = (list, [lowest, highest]) => [...list].sort((a, b) => {
      const distance = (item) => Math.abs((attributes.get(item.id).formality ?? (lowest + highest) / 2) - (lowest + highest) / 2);
      return distance(a) - distance(b) || a.id.localeCompare(b.id);
    });
    shoes = shoes[0] === null ? shoes : nearest(shoes, plan.shoeFormality).slice(0, 5);
    layers = [...layers.filter((layer) => layer === null), ...nearest(layers.filter(Boolean), plan.formality).slice(0, 3)];
  }

  // Pinned pieces already limit their slot above, so every look includes one of them.
  const looks = [];
  for (const top of tops) for (const bottom of bottoms) {
    if (rejectedPairs.has(top.id < bottom.id ? `${top.id}|${bottom.id}` : `${bottom.id}|${top.id}`)) continue;
    for (const layer of layers) for (const shoe of shoes) {
      const pieces = [top, bottom, layer, shoe].filter(Boolean);
      const ids = pieces.map((item) => item.id);
      if (rejectedSets.has(signature(ids))) continue;
      looks.push({ ids, pieces });
    }
  }
  return { looks, gaps, notes, mentioned, relaxed };
}

export function deltaE2000([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const G = 0.5 * (1 - Math.sqrt(((C1 + C2) / 2) ** 7 / (((C1 + C2) / 2) ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (b, a) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);
  let dhp = 0;
  if (C1p * C2p !== 0) dhp = h2p - h1p > 180 ? h2p - h1p - 360 : h2p - h1p < -180 ? h2p - h1p + 360 : h2p - h1p;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) hbp = Math.abs(h1p - h2p) > 180 ? (hbp < 360 ? hbp + 360 : hbp - 360) / 2 : hbp / 2;
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(((L2 - L1) / Sl) ** 2 + ((C2p - C1p) / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * ((C2p - C1p) / Sc) * (dHp / Sh));
}

// Ranks a look by personal history first, then by widely shared style conventions. Notes are shown to the model.
export function scoreLook(look, feedback) {
  const notes = [];
  const key = signature(look.ids);
  let score = 1;
  const personal = look.pieces.map((item) => feedback.recency(item.id) * feedback.underuse(item.id));
  score += personal.reduce((sum, value) => sum + value, 0) / personal.length - 1;
  const pairs = [];
  for (let i = 0; i < look.ids.length; i += 1) for (let j = i + 1; j < look.ids.length; j += 1) {
    const value = feedback.pairScore(look.ids[i], look.ids[j]);
    if (value !== null) pairs.push(value);
  }
  if (pairs.length) score += (0.3 * pairs.reduce((sum, value) => sum + value, 0)) / pairs.length;
  if (feedback.liked.has(key)) notes.push(feedback.liked.get(key));
  if (feedback.wornSets.has(key)) {
    const days = feedback.wornSets.get(key);
    score -= 0.4;
    notes.push(days < 1 ? "worn today" : `worn ${days} day${days === 1 ? "" : "s"} ago`);
  } else {
    const fresh = look.pieces.filter((item) => feedback.lastWornDays(item.id) === 0);
    if (fresh.length) notes.push(`${fresh.map((item) => `"${item.name}"`).join(" and ")} worn today`);
  }
  if (feedback.shownRecently.has(key)) { score -= 0.3; notes.push("suggested in the last few days"); }

  const attributes = look.pieces.map((item) => ({ item, ...normalizeAttributes(item.attributes, item.part) }));
  const accents = new Set(look.pieces.flatMap((item) => [item.color, item.secondaryColor]).map(colorProfile).filter((profile) => profile?.role === "accent").map((profile) => profile.name));
  score -= 0.15 * Math.max(0, accents.size - 2);
  score -= 0.15 * Math.max(0, attributes.filter((entry) => entry.statement).length - 1);
  const patterned = attributes.filter((entry) => entry.pattern && !["solid", "textured"].includes(entry.pattern));
  score -= 0.3 * Math.max(0, patterned.length - 2);
  if (patterned.length === 2 && patterned[0].pattern === patterned[1].pattern && patterned[0].patternScale === patterned[1].patternScale) score -= 0.15;
  const levels = attributes.map((entry) => entry.formality).filter((level) => level !== undefined);
  if (levels.length) score -= 0.1 * Math.max(0, Math.max(...levels) - Math.min(...levels) - 2);
  const clothing = look.pieces.filter((item) => item.part !== "shoes" && /^#[0-9a-f]{6}$/i.test(item.color || ""));
  for (let i = 0; i < clothing.length; i += 1) for (let j = i + 1; j < clothing.length; j += 1) {
    const distance = deltaE2000(lab(clothing[i].color), lab(clothing[j].color));
    if (distance >= 4 && distance < 12) score -= 0.1;
  }
  return { score, notes };
}

function similarity(first, second) {
  const a = new Set(first.ids);
  const shared = second.ids.filter((id) => a.has(id)).length;
  return shared / (a.size + second.ids.length - shared);
}

// Maximal marginal relevance: each pick balances its own score against overlap with looks already chosen.
export function mmrSelect(scored, size, { lambda = 0.7, perPair = 2 } = {}) {
  if (!scored.length) return [];
  // Only the best few hundred can win a place in a short list, so diversity is weighed among those.
  const remaining = [...scored].sort((a, b) => b.score - a.score).slice(0, 600);
  let low = Infinity;
  let high = -Infinity;
  for (const entry of remaining) { low = Math.min(low, entry.score); high = Math.max(high, entry.score); }
  const span = high - low || 1;
  const chosen = [];
  const pairCount = new Map();
  while (chosen.length < size && remaining.length) {
    let best = -1;
    let bestValue = -Infinity;
    remaining.forEach((entry, index) => {
      const pair = entry.ids.slice(0, 2).join("|");
      if ((pairCount.get(pair) || 0) >= perPair) return;
      const overlap = chosen.length ? Math.max(...chosen.map((other) => similarity(entry, other))) : 0;
      const value = lambda * ((entry.score - low) / span) - (1 - lambda) * overlap;
      if (value > bestValue) { bestValue = value; best = index; }
    });
    if (best < 0) break;
    const [entry] = remaining.splice(best, 1);
    const pair = entry.ids.slice(0, 2).join("|");
    pairCount.set(pair, (pairCount.get(pair) || 0) + 1);
    chosen.push(entry);
  }
  return chosen;
}

export function shuffle(list, random = Math.random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function buildShortlist(scored, size = SHORTLIST_SIZE) {
  return shuffle(mmrSelect(scored, size)).map((look, index) => ({ ...look, label: `L${index + 1}` }));
}

export function candidateLine(look, handleOf) {
  return `${look.label}: ${look.ids.map((id) => handleOf.get(id)).join(" + ")}${look.notes.length ? ` (${look.notes.join("; ")})` : ""}`;
}

// Checks the model's picks against the shortlist it was given.
export function validatePicks(raw, shortlist, accessories, count, { required = [], mentioned = [], checkReasons = false } = {}) {
  const picks = raw?.picks;
  if (!Array.isArray(picks) || picks.length !== count) throw new Error(`Return exactly ${count} picks in "picks".`);
  const byLabel = new Map(shortlist.map((look) => [look.label, look]));
  const labels = picks.map((pick) => pick?.look);
  const unknown = labels.filter((label) => !byLabel.has(label));
  if (unknown.length) throw new Error(`Pick only listed candidates; ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not on the list.`);
  if (new Set(labels).size !== labels.length) throw new Error("Pick each candidate at most once.");
  const pairs = labels.map((label) => byLabel.get(label).ids.slice(0, 2).join("|"));
  const distinctPairs = new Set(shortlist.map((look) => look.ids.slice(0, 2).join("|"))).size;
  if (new Set(pairs).size < Math.min(count, distinctPairs)) throw new Error("Choose looks with a different top or bottom from each other; the list has enough of them.");
  const misdescribed = [];
  const valid = picks.map((pick) => {
    const extras = pick.accessories === undefined || pick.accessories === null ? [] : pick.accessories;
    if (!Array.isArray(extras) || extras.length > 2 || new Set(extras).size !== extras.length) throw new Error(`Give "accessories" for ${pick.look} as up to two different A handles.`);
    const missing = extras.filter((handle) => !accessories.has(handle));
    if (missing.length) throw new Error(`Accessories must be listed A handles; ${missing.join(", ")} is not.`);
    const ids = [...byLabel.get(pick.look).ids, ...extras.map((handle) => accessories.get(handle).id)];
    const absent = required.filter((item) => !ids.includes(item.id));
    if (absent.length) throw new Error(`Every look must include ${absent.map((item) => `"${item.name}"`).join(" and ")}.`);
    const claimed = unsupportedColors(pick.reason, [...byLabel.get(pick.look).pieces, ...extras.map((handle) => accessories.get(handle)), ...mentioned]);
    if (claimed.length) misdescribed.push(`${pick.look} mentions ${claimed.join(" and ")}`);
    return { look: byLabel.get(pick.look), garmentIds: ids, name: pick.name, reason: pick.reason };
  });
  if (checkReasons && misdescribed.length) throw new Error(`Describe only colors the chosen pieces have: ${misdescribed.join("; ")}, which ${misdescribed.length === 1 ? "is" : "are"} not in the look.`);
  return valid;
}

// Color words a reason may use, grouped into families so "grey-blue" or "deep red" for burgundy still count as true.
// Words that also name fabrics, drinks, or metals (denim, wine, stone, gold) are left out.
const COLOR_FAMILIES = {
  black: ["black"], white: ["white"], "off-white": ["white"], ivory: ["white"], cream: ["white", "tan"], ecru: ["white", "tan"],
  grey: ["grey"], gray: ["grey"], charcoal: ["grey", "black"], silver: ["grey"], slate: ["blue", "grey"],
  navy: ["blue"], blue: ["blue"], indigo: ["blue"], teal: ["blue", "green"],
  green: ["green"], olive: ["green", "tan"], sage: ["green"], mint: ["green"], khaki: ["tan", "green"],
  tan: ["tan"], beige: ["tan"], camel: ["tan", "brown"], brown: ["brown"], chocolate: ["brown"],
  burgundy: ["red"], maroon: ["red"], red: ["red"], rust: ["orange", "red"], terracotta: ["orange"], orange: ["orange"],
  mustard: ["yellow"], yellow: ["yellow"], pink: ["pink"], coral: ["pink", "orange"],
  purple: ["purple"], plum: ["purple", "red"], lavender: ["purple"],
};
const COLOR_WORD = new RegExp(`\\b(${Object.keys(COLOR_FAMILIES).sort((a, b) => b.length - a.length).join("|")})\\b`, "gi");

// Colors a reason claims that none of the look's garments have, by measured color, name, or tags.
export function unsupportedColors(reason, pieces) {
  const present = new Set();
  for (const item of pieces) {
    const text = [item.name, ...(item.tags || []), ...[item.color, item.secondaryColor].map((hex) => colorProfile(hex)?.name || "")].join(" ");
    for (const [word] of text.matchAll(COLOR_WORD)) COLOR_FAMILIES[word.toLowerCase()].forEach((family) => present.add(family));
  }
  const claimed = [...new Set([...String(reason || "").matchAll(COLOR_WORD)].map(([word]) => word.toLowerCase()))];
  return claimed.filter((word) => !COLOR_FAMILIES[word].some((family) => present.has(family)));
}

// One-step edits of a look: swap, remove, or add a single piece. Revisions prefer these over rebuilding the look.
export function singleChanges(lookIds, items, handleOf, { anchorId = "" } = {}) {
  const current = lookIds.map((id) => items.find((item) => item.id === id)).filter(Boolean);
  const options = [];
  const add = (ids, text) => options.push({ label: `V${options.length + 1}`, ids, text });
  for (const piece of current) {
    if (piece.id === anchorId) continue;
    for (const other of items) {
      if (other.part === piece.part && !lookIds.includes(other.id)) add(lookIds.map((id) => (id === piece.id ? other.id : id)), `swap ${handleOf.get(piece.id)} for ${handleOf.get(other.id)}`);
    }
    if (["wholebody_up", "shoes", "accessories_up"].includes(piece.part)) add(lookIds.filter((id) => id !== piece.id), `remove ${handleOf.get(piece.id)}`);
  }
  for (const part of ["wholebody_up", "shoes"]) {
    if (current.some((item) => item.part === part)) continue;
    for (const other of items.filter((item) => item.part === part)) add([...lookIds, other.id], `add ${handleOf.get(other.id)}`);
  }
  if (current.filter((item) => item.part === "accessories_up").length < 2) {
    for (const other of items.filter((item) => item.part === "accessories_up" && !lookIds.includes(item.id))) add([...lookIds, other.id], `add ${handleOf.get(other.id)}`);
  }
  return options;
}

export function partLabel(part) {
  return PART_LABELS[part] || part;
}

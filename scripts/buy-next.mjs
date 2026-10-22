// Ranks pieces the wearer could buy by the new complete outfits each would add across their occasions.
// The model plans each occasion and proposes the pieces; code counts the outfits, as in capsule-wardrobe versatility.
import { CATEGORIES, colorProfile, fieldsForPart, lab, normalizeAttributes, PART_LABELS } from "./garment-attributes.mjs";
import { deltaE2000, enumerateLooks, scoreLook } from "./outfit-engine.mjs";
import { profileScore } from "./profile.mjs";

const HEX = /^#[0-9a-f]{6}$/i;
export const BUYABLE_PARTS = ["upperbody", "lowerbody", "wholebody_up", "shoes"];
export const DEFAULT_OCCASIONS = ["everyday", "office", "dinner out", "formal event"];
// History that treats every piece as equally fresh, so a look with no style penalties scores exactly 1.
const NEUTRAL = { recency: () => 1, underuse: () => 1, pairScore: () => null, lastWornDays: () => null, liked: new Map(), wornSets: new Map(), shownRecently: new Set() };
// Looks whose style penalties add up to more than 0.25, two clashes for example, are not counted as outfits worth wearing.
const QUALITY_FLOOR = 0.75;

// The occasions the wearer has asked the stylist for, most frequent first, weighted gently by how often.
export function historyOccasions(looks = []) {
  const counts = new Map();
  for (const look of looks) {
    const name = String(look.occasion || "").trim().toLowerCase();
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return new Map([...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => [name, 1 + Math.log2(count)]));
}

export function attributeOptions() {
  return BUYABLE_PARTS.map((part) => `${part}: ${fieldsForPart(part).map((field) => `${field.key} (${field.key === "category" ? CATEGORIES[part].join("|") : field.values.join("|")})`).join("; ")}`).join("\n");
}

// Turns the model's proposals into hypothetical wardrobe items; proposals without formality or warmth cannot be counted fairly.
export function normalizeCandidates(raw) {
  const list = Array.isArray(raw?.candidates) ? raw.candidates : [];
  return list.flatMap((entry, index) => {
    if (!entry || !BUYABLE_PARTS.includes(entry.part) || typeof entry.name !== "string" || !HEX.test(entry.color || "")) return [];
    const attributes = normalizeAttributes(entry.attributes, entry.part);
    if (attributes.formality === undefined || attributes.warmth === undefined) return [];
    return [{
      id: `candidate-${index + 1}`, name: entry.name.trim().slice(0, 80), part: entry.part, color: entry.color.toLowerCase(),
      secondaryColor: HEX.test(entry.secondaryColor || "") ? entry.secondaryColor.toLowerCase() : null, tags: [], attributes,
      why: typeof entry.why === "string" ? entry.why.trim().slice(0, 300) : "",
    }];
  });
}

// Distinct top and bottom pairs that can be worn complete for the plan: with shoes, and with a layer when one is needed.
export function completeOutfits(items, plan, quality) {
  const { looks, gaps, notes, relaxed } = enumerateLooks(items, plan);
  const pairs = new Map();
  if (relaxed.size) return { pairs, gaps, notes };
  for (const look of looks) {
    if (!look.pieces.some((piece) => piece.part === "shoes")) continue;
    if (plan.outerLayer === "needed" && !look.pieces.some((piece) => piece.part === "wholebody_up")) continue;
    const score = quality(look);
    if (score < QUALITY_FLOOR) continue;
    const key = look.ids.slice(0, 2).join("|");
    if (!pairs.has(key) || pairs.get(key).score < score) pairs.set(key, { ...look, score });
  }
  return { pairs, gaps, notes };
}

// Style score without personal history, so a purchase is judged on fit with the wardrobe rather than on what was worn lately.
function judge(profile) {
  const cache = new Map();
  return (look) => {
    const key = look.ids.join("|");
    if (!cache.has(key)) cache.set(key, scoreLook(look, NEUTRAL).score + profileScore(look, profile).score);
    return cache.get(key);
  };
}

// Whether a piece could be worn for the plan at all, judged on its own formality and warmth.
function fits(item, plan) {
  if (item.part === "wholebody_up" && plan.outerLayer === "skip") return false;
  const { formality, warmth } = normalizeAttributes(item.attributes, item.part);
  const [lowest, highest] = item.part === "shoes" ? plan.shoeFormality : plan.formality;
  const maxWarmth = item.part === "wholebody_up" ? plan.layerMaxWarmth : plan.maxWarmth;
  return (formality === undefined || (formality >= lowest && formality <= highest)) && (maxWarmth === null || warmth === undefined || warmth <= maxWarmth);
}

function combinations(list, size) {
  if (size === 1) return list.map((entry) => [entry]);
  return list.flatMap((entry, index) => combinations(list.slice(index + 1), size - 1).map((rest) => [entry, ...rest]));
}

export function wardrobeCoverage(items, occasions, profile = {}) {
  const quality = judge(profile);
  return occasions.map((occasion) => {
    const { pairs, gaps, notes } = completeOutfits(items, occasion.plan, quality);
    return { occasion: occasion.name, outfits: pairs.size, gaps, notes };
  });
}

// What a set of new pieces adds to a wardrobe, with diminishing returns within each occasion: a first formal outfit counts for more than a fifth casual one.
function contribution(owned, set, occasions, current, quality) {
  const ids = new Set(set.map((candidate) => candidate.id));
  const examples = [];
  const breakdown = occasions.map((occasion, index) => {
    const { pairs } = completeOutfits([...owned, ...set], occasion.plan, quality);
    const before = current[index];
    for (const look of pairs.values()) if (look.ids.some((id) => ids.has(id))) examples.push({ occasion: occasion.name, ids: look.ids, score: look.score });
    return { occasion: occasion.name, before, after: pairs.size, value: occasion.weight * (Math.log2(1 + pairs.size) - Math.log2(1 + before)) };
  });
  return {
    set, breakdown, examples: bestPerOccasion(examples).slice(0, 2),
    added: breakdown.reduce((sum, entry) => sum + entry.after - entry.before, 0),
    value: Math.round(breakdown.reduce((sum, entry) => sum + entry.value, 0) * 100) / 100,
  };
}

// An owned piece of the same type and color; buying its twin adds rotation, not new looks. Color distance alone cannot
// tell white from a pale blue, so a shared color name counts, as does a near-identical color.
export function ownedTwin(candidate, items) {
  const name = colorProfile(candidate.color)?.name;
  if (!candidate.attributes.category) return null;
  return items.find((item) => item.part === candidate.part && item.attributes?.category === candidate.attributes.category && HEX.test(item.color || "")
    && (colorProfile(item.color)?.name === name || deltaE2000(lab(item.color), lab(candidate.color)) < 5)) || null;
}

// A buying order, built greedily as in capsule-wardrobe selection: each step takes the piece that adds most on top of the earlier picks.
// When no single piece adds an outfit, pieces for different slots that only work together (a shirt, trousers, and shoes) are tried as a set.
export function rankPurchases(items, occasions, candidates, profile = {}) {
  const quality = judge(profile);
  const counts = (owned) => occasions.map((occasion) => completeOutfits(owned, occasion.plan, quality).pairs.size);
  const start = counts(items);
  const alone = new Map(candidates.map((candidate) => [candidate.id, contribution(items, [candidate], occasions, start, quality)]));
  const owned = [...items];
  const order = [];
  const twins = new Map(candidates.map((candidate) => [candidate.id, ownedTwin(candidate, items)]));
  let remaining = candidates.filter((candidate) => !twins.get(candidate.id));
  while (remaining.length) {
    const current = counts(owned);
    let best = null;
    for (const size of [1, 2, 3]) {
      const sets = combinations(remaining, size).filter((set) => new Set(set.map((candidate) => candidate.part)).size === set.length);
      best = sets.map((set) => contribution(owned, set, occasions, current, quality)).sort((a, b) => b.value - a.value || b.added - a.added)[0];
      if (best?.value > 0) break;
    }
    if (!best || best.value <= 0) break;
    order.push(best);
    owned.push(...best.set);
    remaining = remaining.filter((candidate) => !best.set.includes(candidate));
  }
  const present = (entry, candidate, step) => {
    const { why, ...item } = candidate;
    const { set, ...counted } = entry;
    return {
      item, why, step, ...counted,
      together: set.filter((other) => other !== candidate).map((other) => other.name),
      alone: { value: alone.get(candidate.id).value, added: alone.get(candidate.id).added },
    };
  };
  const covered = candidates.filter((candidate) => !order.some((entry) => entry.set.includes(candidate))).map((candidate) => {
    const standalone = alone.get(candidate.id);
    // A piece that would have helped on its own but adds nothing after the picks above is an alternative to the first pick in its slot.
    const rival = standalone.value > 0 ? order.find((entry) => entry.set.some((other) => other.part === candidate.part)) : null;
    const twin = twins.get(candidate.id);
    // The model's pitch was written before counting, so a piece that adds nothing gets the counted reason instead.
    const fitting = occasions.filter((occasion) => fits(candidate, occasion.plan));
    const stuck = fitting.map((occasion) => ({ occasion, outcome: completeOutfits([...owned, candidate], occasion.plan, quality) }))
      .find(({ outcome }) => outcome.pairs.size === 0 && outcome.notes.length);
    const note = twin || rival ? null
      : !fitting.length ? "It does not fit the plan for any of these occasions."
        : stuck ? `It would need other pieces too. For ${stuck.occasion.name}: ${stuck.outcome.notes.join(" ")}`
          : candidate.part === "wholebody_up" && !occasions.some((occasion) => occasion.plan.outerLayer === "needed")
            ? "None of these occasions needs an outer layer, so it would only change outfits you can already complete. Add an occasion such as a cold evening to count it."
            : candidate.part === "shoes" ? "Shoes you own already complete the outfits it could join."
              : "Every outfit it could join can already be completed with pieces you own.";
    return { ...present({ ...standalone, set: [candidate] }, candidate, null), alternativeTo: rival ? rival.set.find((other) => other.part === candidate.part).name : null, similarTo: twin?.name || null, note };
  }).sort((a, b) => b.alone.value - a.alone.value);
  return {
    coverage: occasions.map((occasion, index) => {
      const { gaps, notes } = completeOutfits(items, occasion.plan, quality);
      return { occasion: occasion.name, outfits: start[index], gaps, notes };
    }),
    results: [...order.flatMap((entry, index) => entry.set.map((candidate) => present(entry, candidate, index + 1))), ...covered],
  };
}

function bestPerOccasion(looks) {
  const best = new Map();
  for (const look of looks) if (!best.has(look.occasion) || best.get(look.occasion).score < look.score) best.set(look.occasion, look);
  return [...best.values()].sort((a, b) => b.score - a.score);
}

export function partName(part) {
  return PART_LABELS[part] || part;
}

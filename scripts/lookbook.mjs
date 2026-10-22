// Every outfit the wardrobe can make, for browsing by genre. Code builds and scores the outfits; the model names the genres and sorts outfits into them.
import { signature } from "./feedback.mjs";
import { normalizeAttributes } from "./garment-attributes.mjs";
import { NEUTRAL_HISTORY, scoreLook, unsupportedColors } from "./outfit-engine.mjs";
import { profileScore } from "./profile.mjs";

const MAX_OUTFITS = 400;
export const SKIP = "skip";

// Changes whenever a piece is added, removed, recolored, or redescribed, so a saved lookbook knows it is out of date.
export function librarySignature(items) {
  const text = signature(items.map((item) => `${item.id}:${item.part}:${item.color}:${JSON.stringify(normalizeAttributes(item.attributes, item.part))}`));
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16);
}

// Each top and bottom, alone and under each layer, with the shoes closest in formality to the clothes.
export function allOutfits(items, { profile = {}, hidden = new Set() } = {}) {
  const of = (part) => items.filter((item) => item.part === part);
  const formality = (item) => normalizeAttributes(item.attributes, item.part).formality;
  const shoes = of("shoes");
  const outfits = [];
  for (const top of of("upperbody")) for (const bottom of of("lowerbody")) for (const layer of [null, ...of("wholebody_up")]) {
    const clothes = [top, bottom, layer].filter(Boolean);
    const levels = clothes.map(formality).filter((level) => level !== undefined);
    const mean = levels.length ? levels.reduce((sum, level) => sum + level, 0) / levels.length : null;
    const nearest = shoes.map((shoe) => ({ shoe, gap: mean === null || formality(shoe) === undefined ? 0 : formality(shoe) - mean }))
      .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap) || a.shoe.id.localeCompare(b.shoe.id))[0];
    // Shoes more than two steps from the clothes would undo the outfit, so it is shown without them and says what it needs.
    const fitting = nearest && Math.abs(nearest.gap) <= 2 ? nearest.shoe : null;
    const note = nearest && !fitting ? `Needs ${nearest.gap < 0 ? "dressier" : "more casual"} shoes` : "";
    const pieces = [...clothes, fitting].filter(Boolean);
    const ids = pieces.map((piece) => piece.id);
    if (hidden.has(signature(ids))) continue;
    const look = { ids, pieces };
    outfits.push({ ids, note, score: Math.round((scoreLook(look, NEUTRAL_HISTORY).score + profileScore(look, profile).score) * 1000) / 1000 });
  }
  if (outfits.length <= MAX_OUTFITS) return outfits.sort((a, b) => b.score - a.score);
  // Large wardrobes keep the two best versions of each top and bottom pair, then the best overall.
  const perPair = new Map();
  for (const outfit of [...outfits].sort((a, b) => b.score - a.score)) {
    const pair = outfit.ids.slice(0, 2).join("|");
    if ((perPair.get(pair) || []).length < 2) perPair.set(pair, [...(perPair.get(pair) || []), outfit]);
  }
  return [...perPair.values()].flat().sort((a, b) => b.score - a.score).slice(0, MAX_OUTFITS);
}

export function validateGenres(raw) {
  const list = Array.isArray(raw?.genres) ? raw.genres : [];
  const genres = list.map((entry) => ({ name: String(entry?.name || "").trim().slice(0, 40), description: String(entry?.description || "").trim().slice(0, 200) }))
    .filter((entry) => entry.name && entry.name.toLowerCase() !== SKIP);
  const unique = [...new Map(genres.map((entry) => [entry.name.toLowerCase(), entry])).values()];
  if (unique.length < 3 || unique.length > 8) throw new Error('Return 4 to 7 genres in "genres", each with a name and a description.');
  return unique;
}

// Checks one batch of genre assignments; outfits it misses are listed so the model can be asked again.
export function readAssignments(raw, batch, genres) {
  const names = new Map(genres.map((genre) => [genre.name.toLowerCase(), genre.name]));
  const answers = new Map((Array.isArray(raw?.outfits) ? raw.outfits : []).map((entry) => [entry?.id, entry]));
  const assigned = [];
  const missing = [];
  for (const outfit of batch) {
    const answer = answers.get(outfit.handle);
    const genre = String(answer?.genre || "").trim().toLowerCase();
    if (!answer || !(genre === SKIP || names.has(genre))) { missing.push(outfit.handle); continue; }
    assigned.push({ ...outfit, genre: genre === SKIP ? SKIP : names.get(genre), name: String(answer.name || "").trim().slice(0, 60) });
  }
  return { assigned, missing };
}

// A name built from the pieces, for outfits the model did not name or named with colors they do not have.
export function plainName(pieces) {
  const short = (item) => item.name.split(/\s+/).slice(-2).join(" ");
  return pieces.filter((piece) => piece.part !== "shoes").map(short).join(" + ");
}

export function finishOutfit(outfit, byId) {
  const pieces = outfit.ids.map((id) => byId.get(id)).filter(Boolean);
  const name = outfit.name && !unsupportedColors(outfit.name, pieces).length ? outfit.name : plainName(pieces);
  return { ids: outfit.ids, genre: outfit.genre, name, note: outfit.note, score: outfit.score };
}

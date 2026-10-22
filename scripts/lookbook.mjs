// A curated lookbook: code builds every outfit and ranks it by style and by Sanzo Wada's dictionary; the model picks the ones worth wearing and groups them by genre.
import { signature } from "./feedback.mjs";
import { normalizeAttributes } from "./garment-attributes.mjs";
import { NEUTRAL_HISTORY, scoreLook, unsupportedColors } from "./outfit-engine.mjs";
import { profileScore } from "./profile.mjs";

const MAX_OUTFITS = 400;

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

export function validateGenres(raw, [fewest, most] = [3, 6]) {
  const list = Array.isArray(raw?.genres) ? raw.genres : [];
  const genres = list.map((entry) => ({ name: String(entry?.name || "").trim().slice(0, 40), description: String(entry?.description || "").trim().slice(0, 200) }))
    .filter((entry) => entry.name);
  const unique = [...new Map(genres.map((entry) => [entry.name.toLowerCase(), entry])).values()];
  if (unique.length < fewest || unique.length > most) throw new Error(`Return ${fewest} to ${most} genres in "genres", each with a name and a description.`);
  return unique;
}

// A name built from the pieces, for outfits named with colors they do not have.
export function plainName(pieces) {
  const short = (item) => item.name.split(/\s+/).slice(-2).join(" ");
  return pieces.filter((piece) => piece.part !== "shoes").map(short).join(" + ");
}

// Checks the stylist's picks: listed outfits only, each once, in a named genre, with a reason that mentions only colors the outfit has.
// Reasons with false colors are sent back once, then dropped; names with false colors are replaced.
export function readCuration(raw, shortlist, { fewest, most = 30, checkReasons = false }) {
  const genres = validateGenres(raw);
  const names = new Map(genres.map((genre) => [genre.name.toLowerCase(), genre.name]));
  const byHandle = new Map(shortlist.map((outfit) => [outfit.handle, outfit]));
  const picks = Array.isArray(raw?.outfits) ? raw.outfits : [];
  const unknown = picks.filter((pick) => !byHandle.has(pick?.id)).map((pick) => pick?.id);
  if (unknown.length) throw new Error(`Choose only listed outfits; ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not listed.`);
  const misplaced = picks.filter((pick) => !names.has(String(pick.genre || "").trim().toLowerCase())).map((pick) => pick.id);
  if (misplaced.length) throw new Error(`Put every outfit in one of your genres; ${misplaced.join(", ")} ${misplaced.length === 1 ? "is" : "are"} not.`);
  const chosen = [...new Map(picks.map((pick) => [pick.id, pick])).values()].slice(0, most);
  if (chosen.length < fewest) throw new Error(`Choose at least ${fewest} outfits worth wearing.`);
  const misdescribed = [];
  const outfits = chosen.map((pick) => {
    const outfit = byHandle.get(pick.id);
    const name = String(pick.name || "").trim().slice(0, 60);
    const why = String(pick.why || "").trim().slice(0, 240);
    const claimed = unsupportedColors(why, outfit.pieces);
    if (claimed.length) misdescribed.push(`${pick.id} mentions ${claimed.join(" and ")}`);
    return {
      ids: outfit.ids, genre: names.get(String(pick.genre).trim().toLowerCase()),
      name: name && !unsupportedColors(name, outfit.pieces).length ? name : plainName(outfit.pieces),
      why: claimed.length ? "" : why, palette: outfit.palette, note: outfit.note, score: outfit.score,
    };
  });
  if (checkReasons && misdescribed.length) throw new Error(`Describe only colors the outfit's pieces have: ${misdescribed.join("; ")}.`);
  const used = new Set(outfits.map((outfit) => outfit.genre));
  return { genres: genres.filter((genre) => used.has(genre.name)), outfits };
}

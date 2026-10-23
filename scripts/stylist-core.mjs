import { readFile } from "node:fs/promises";
import { colorProfile, lab } from "./garment-attributes.mjs";
import { deltaE2000 } from "./outfit-engine.mjs";

const colors = JSON.parse(await readFile(new URL("./wada-colors.json", import.meta.url), "utf8"));
const paletteMap = new Map();
for (const color of colors) {
  for (const id of color.combinations) {
    if (!paletteMap.has(id)) paletteMap.set(id, []);
    paletteMap.get(id).push({ name: color.name, hex: color.hex });
  }
}

const HEX = /^#[0-9a-f]{6}$/i;
const PARTS = new Set(["upperbody", "lowerbody", "wholebody_up", "accessories_up", "shoes"]);
export const PACK_STATES = new Set(["planned", "packed", "worn"]);

// Sanzo Wada's combinations in CIELAB, so garment colors can be matched to them by perceived difference.
const COMBINATIONS = [...paletteMap.entries()].map(([id, swatches]) => ({ id, swatches: swatches.map((swatch) => ({ ...swatch, lab: lab(swatch.hex) })) }));
// A garment color within this ΔE2000 of a swatch reads as that swatch. Looser limits let almost any pair match one of 348 combinations.
const MATCH_DISTANCE = 10;
const nearest = new Map();

function nearestSwatch(hex, combination) {
  const key = `${hex}|${combination.id}`;
  if (!nearest.has(key)) {
    const color = lab(hex);
    nearest.set(key, combination.swatches.reduce((best, swatch, index) => {
      const distance = deltaE2000(color, swatch.lab);
      return distance < best.distance ? { distance, index } : best;
    }, { distance: Infinity, index: -1 }));
  }
  return nearest.get(key);
}

// The dictionary combination an outfit's colors follow: every non-neutral garment color close to a swatch, using at least two swatches.
// Greys, black, and white go with anything, so they never decide a match. Returns null when fewer than two colors or no combination fits.
export function wadaMatch(pieces) {
  const colors = [...new Set(pieces.filter((piece) => piece.part !== "accessories_up").map((piece) => piece.color).filter((hex) => HEX.test(hex || "")))]
    .filter((hex) => colorProfile(hex).chroma >= 8);
  if (colors.length < 2) return null;
  let best = null;
  for (const combination of COMBINATIONS) {
    const used = new Set();
    let total = 0;
    for (const hex of colors) {
      const { distance, index } = nearestSwatch(hex, combination);
      if (distance > MATCH_DISTANCE) { total = Infinity; break; }
      total += distance;
      used.add(index);
    }
    if (total === Infinity || used.size < 2 || (best && total / colors.length >= best.distance)) continue;
    best = { id: combination.id, colors: combination.swatches.map(({ name, hex }) => ({ name, hex })), distance: total / colors.length };
  }
  return best && { ...best, distance: Math.round(best.distance * 10) / 10 };
}

// Ranking weight for color: a close dictionary match counts most, a single accent over neutrals is safe, other color mixes are unproven.
export function colorHarmony(pieces) {
  const match = wadaMatch(pieces);
  if (match) return { score: 0.2 - match.distance / 50, palette: match };
  const colored = new Set(pieces.filter((piece) => piece.part !== "accessories_up" && HEX.test(piece.color || "") && colorProfile(piece.color).chroma >= 8).map((piece) => piece.color));
  return { score: colored.size < 2 ? 0.1 : 0, palette: null };
}

export function eligibleItems(trip, library) {
  if (!trip) return library;
  return library.filter((item) => ["packed", "worn"].includes(trip.items?.[item.id]));
}

// Long reasons end at the last full sentence that fits rather than mid-word.
function clip(text, limit) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const end = cut.search(/[.!?](?=[^.!?]*$)/);
  return end > limit / 2 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
}

export function validateLook(value, availableItems) {
  const byId = new Map(availableItems.map((item) => [item.id, item]));
  const ids = value?.garmentIds;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 6 || new Set(ids).size !== ids.length) {
    throw new Error("A look must contain two to six distinct wardrobe items.");
  }
  const garments = ids.map((id) => byId.get(id));
  if (garments.some((item) => !item)) throw new Error("A look contains an item outside the available wardrobe.");
  const counts = Object.fromEntries([...PARTS].map((part) => [part, garments.filter((item) => item.part === part).length]));
  if (counts.upperbody !== 1 || counts.lowerbody !== 1
      || counts.wholebody_up > 1 || counts.accessories_up > 2 || counts.shoes > 1) {
    throw new Error("A look needs one top and one bottom, with at most one layer, two accessories, and pair of shoes.");
  }
  const palette = wadaMatch(garments);
  return {
    name: String(value.name || "New look").trim().slice(0, 80) || "New look",
    reason: clip(value.reason, 500),
    occasion: String(value.occasion || "").trim().slice(0, 80),
    garmentIds: ids,
    palette: palette ? { id: palette.id, colors: palette.colors } : null,
  };
}

export function warningsFor(look, trip) {
  if (!trip) return [];
  return look.garmentIds
    .filter((id) => trip.items?.[id] === "worn")
    .map((id) => ({ itemId: id, text: "Marked worn or in laundry on this trip." }));
}

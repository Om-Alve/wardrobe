import { readFile } from "node:fs/promises";

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
const CLOTHING_PARTS = new Set(["upperbody", "lowerbody", "wholebody_up"]);
export const PACK_STATES = new Set(["planned", "packed", "worn"]);

function rgb(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function distance(first, second) {
  const a = rgb(first);
  const b = rgb(second);
  return Math.sqrt(a.reduce((sum, value, index) => sum + ((value - b[index]) ** 2), 0));
}

export function relevantPalettes(items, limit = 10, anchorId = "") {
  const garmentColors = items
    .filter((item) => CLOTHING_PARTS.has(item.part))
    .flatMap((item) => [item.color, item.secondaryColor])
    .filter((hex) => typeof hex === "string" && HEX.test(hex));
  if (!garmentColors.length) return [];
  const anchor = items.find((item) => item.id === anchorId && CLOTHING_PARTS.has(item.part));
  const anchorColors = [anchor?.color, anchor?.secondaryColor].filter((hex) => typeof hex === "string" && HEX.test(hex));
  return [...paletteMap.entries()].map(([id, swatches]) => ({
    id,
    colors: swatches,
    score: (anchorColors.length ? Math.min(...anchorColors.flatMap((hex) => swatches.map((swatch) => distance(hex, swatch.hex)))) * 2 : 0)
      + garmentColors
      .map((hex) => Math.min(...swatches.map((swatch) => distance(hex, swatch.hex))))
      .sort((a, b) => a - b)
      .slice(0, Math.min(3, garmentColors.length))
      .reduce((sum, value) => sum + value, 0)
      - swatches.filter((swatch) => garmentColors.some((hex) => distance(hex, swatch.hex) < 65)).length * 20,
  })).sort((a, b) => a.score - b.score).slice(0, limit)
    .map(({ id, colors: paletteColors }) => ({ id, colors: paletteColors }));
}

export function eligibleItems(trip, library) {
  if (!trip) return library;
  return library.filter((item) => ["packed", "worn"].includes(trip.items?.[item.id]));
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
  const palette = relevantPalettes(garments, 1)[0] || null;
  return {
    name: String(value.name || "New look").trim().slice(0, 80) || "New look",
    reason: String(value.reason || "").trim().slice(0, 500),
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

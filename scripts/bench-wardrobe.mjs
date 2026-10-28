#!/usr/bin/env node
// Builds benchmark wardrobes of 30, 60, and 120 pieces from a public product catalog (Myntra product images on Hugging Face),
// described by the configured vision model exactly as imports are. Output goes to data/bench/, which git ignores.
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describeGarment } from "./import-job-api.mjs";
import { llmSettings } from "./llm-client.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
if (existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"));
const bench = path.join(root, "data", "bench");
const images = path.join(bench, "images");
const API = "https://datasets-server.huggingface.co/rows";
const SMALL = "ashraq/fashion-product-images-small";
const FULL = "benitomartin/fashion-product-images-small-900x1200";

// Pieces per catalog type in the largest wardrobe; the smaller ones take the first half and quarter of each.
const PLAN = {
  Tshirts: ["upperbody", 14], Shirts: ["upperbody", 18], Sweatshirts: ["upperbody", 4], Sweaters: ["upperbody", 4],
  Jackets: ["wholebody_up", 8], Blazers: ["wholebody_up", 4],
  Jeans: ["lowerbody", 10], Trousers: ["lowerbody", 12], Shorts: ["lowerbody", 4], "Track Pants": ["lowerbody", 4],
  "Casual Shoes": ["shoes", 8], "Formal Shoes": ["shoes", 6], "Sports Shoes": ["shoes", 4], Sandals: ["shoes", 2],
  Watches: ["accessories_up", 8], Belts: ["accessories_up", 6], Backpacks: ["accessories_up", 4],
};
const SIZES = { s: 0.25, m: 0.5, l: 1 };
// The catalog names colors; these are representative values for them.
const COLORS = {
  Black: "#141414", White: "#f5f5f2", "Off White": "#ece6d8", Cream: "#efe3c4", Beige: "#d8c7a6", Khaki: "#b9a77c", Tan: "#c6a466",
  Brown: "#7b5234", "Coffee Brown": "#4a3322", "Mushroom Brown": "#8b7d6b", Taupe: "#8b7d6b", Grey: "#8a8d90", "Grey Melange": "#9a9c9f",
  Charcoal: "#36393d", Silver: "#c0c4c8", Steel: "#8e959b", "Navy Blue": "#1d2840", Blue: "#2f5aa0", Teal: "#2a7072",
  "Turquoise Blue": "#3fb8c4", "Sea Green": "#2e8b57", Green: "#3f7d4b", Olive: "#6b6d3a", "Lime Green": "#9ac43a",
  Yellow: "#ecd04b", Mustard: "#c9a227", Orange: "#e07b39", Peach: "#f2b48e", Red: "#b3332e", Maroon: "#6e2a3a",
  Burgundy: "#6e2a3a", Rust: "#a5502e", Pink: "#e6a4b4", Rose: "#c97b8a", Magenta: "#b03a7a", Purple: "#5f4a8b",
  Lavender: "#b4a6d6", Mauve: "#a7819e", Gold: "#c9a24a", Bronze: "#a0703a", Copper: "#b06a3a", Nude: "#e3c4a8",
};

function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// The public dataset API rate-limits, so requests back off and retry, honoring Retry-After when it is given.
async function json(url, tries = 8) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) }).catch((error) => ({ ok: false, statusText: error.message, headers: new Headers() }));
    if (response.ok) return response.json();
    if (attempt >= tries) throw new Error(`${url}: ${response.status || ""} ${response.statusText}`);
    const wait = Number(response.headers.get("retry-after")) * 1000 || 2000 * 2 ** (attempt - 1);
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 60000)));
  }
}

async function pool(list, size, work) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < list.length) { const index = next++; results[index] = await work(list[index], index); }
  }));
  return results;
}

// Catalog records, sampled in pages across the whole catalog and cached.
async function catalog() {
  const file = path.join(bench, "catalog.json");
  if (existsSync(file)) return JSON.parse(await readFile(file, "utf8"));
  const pagesDir = path.join(bench, "catalog-pages");
  await mkdir(pagesDir, { recursive: true });
  const offsets = Array.from({ length: 60 }, (_, index) => index * 730);
  const pages = await pool(offsets, 2, async (offset) => {
    const cached = path.join(pagesDir, `${offset}.json`);
    if (existsSync(cached)) return JSON.parse(await readFile(cached, "utf8"));
    const rows = (await json(`${API}?dataset=${SMALL}&config=default&split=train&offset=${offset}&length=100`)).rows
      .map(({ row_idx: index, row }) => ({ index, ...Object.fromEntries(Object.entries(row).filter(([key]) => key !== "image")) }));
    await writeFile(cached, JSON.stringify(rows));
    return rows;
  });
  const rows = pages.flat();
  await writeFile(file, JSON.stringify(rows));
  return rows;
}

const records = await catalog();
const random = seeded(20261022);
const chosen = [];
for (const [type, [part, count]] of Object.entries(PLAN)) {
  // Adult menswear only: the catalog's unisex items include kidswear, which no adult wardrobe should offer.
  const fits = records.filter((row) => row.articleType === type && row.gender === "Men" && row.usage !== "Ethnic" && COLORS[row.baseColour]
    && !/\b(kids?|infant|baby|boys|girls|gini (and|&) jony)\b/i.test(row.productDisplayName));
  // Spread each type across colors: shuffle, then take one per color in turn.
  const byColor = new Map();
  for (const row of fits.sort(() => random() - 0.5)) byColor.set(row.baseColour, [...(byColor.get(row.baseColour) || []), row]);
  const picks = [];
  while (picks.length < count && [...byColor.values()].some((list) => list.length)) {
    for (const list of byColor.values()) if (list.length && picks.length < count) picks.push(list.shift());
  }
  if (picks.length < count) console.warn(`Only ${picks.length} of ${count} ${type} available.`);
  picks.forEach((row, rank) => chosen.push({ row, part, type, rank, share: (rank + 1) / count }));
}

await mkdir(images, { recursive: true });
await pool(chosen, 2, async ({ row }) => {
  const file = path.join(images, `bench-${row.id}.png`);
  if (existsSync(file)) return;
  const source = (await json(`${API}?dataset=${FULL}&config=default&split=train&offset=${row.index}&length=1`)).rows[0].row.image.src;
  const bytes = Buffer.from(await (await fetch(source, { signal: AbortSignal.timeout(60000) })).arrayBuffer());
  await writeFile(file, await sharp(bytes).resize(480, 640, { fit: "inside" }).png().toBuffer());
});
console.log(`Images ready for ${chosen.length} pieces.`);

const describedFile = path.join(bench, "attributes.json");
const described = existsSync(describedFile) ? JSON.parse(await readFile(describedFile, "utf8")) : {};
const setting = (name, fallback = "") => process.env[name] || fallback;
const llm = llmSettings(setting);
const items = await pool(chosen, 6, async ({ row, part, type, share }) => {
  const item = {
    id: `bench-${row.id}`, name: row.productDisplayName.replace(/\s+/g, " ").trim(), part, color: COLORS[row.baseColour], secondaryColor: null,
    tags: [type.toLowerCase(), row.baseColour.toLowerCase(), row.usage?.toLowerCase(), row.season?.toLowerCase()].filter(Boolean),
    image: `/api/import/library/bench-${row.id}.png`, thumbnail: `/api/import/library/bench-${row.id}.png`, catalog: { type, usage: row.usage, colour: row.baseColour }, share,
  };
  if (!described[item.id]) {
    try {
      described[item.id] = await describeGarment({ ...llm, image: await readFile(path.join(images, `${item.id}.png`)), item });
    } catch (error) { console.warn(`Could not describe ${item.name}: ${error.message}`); }
  }
  return { ...item, attributes: described[item.id] || {}, attributesSource: described[item.id] ? "model" : null };
});
await writeFile(describedFile, JSON.stringify(described, null, 2));

for (const [size, share] of Object.entries(SIZES)) {
  const dir = path.join(bench, size);
  // Only the wardrobe itself is replaced; earlier runs and grades in the folder are kept.
  await mkdir(dir, { recursive: true });
  if (!existsSync(path.join(dir, "imported"))) await symlink(images, path.join(dir, "imported"));
  const library = items.filter((item) => item.share <= share + 1e-9).map(({ share: _, ...item }) => item);
  await writeFile(path.join(dir, "library.json"), `${JSON.stringify(library, null, 2)}\n`);
  console.log(`${size.toUpperCase()}: ${library.length} pieces in data/bench/${size}`);
}
const usage = items.filter((item) => item.attributes.formality !== undefined && ["Casual", "Formal", "Sports", "Smart Casual", "Party"].includes(item.catalog.usage));
const mean = (list) => (list.reduce((sum, value) => sum + value, 0) / (list.length || 1)).toFixed(2);
console.log("Described formality by catalog usage:", Object.entries(Object.groupBy(usage, (item) => item.catalog.usage)).map(([name, list]) => `${name} ${mean(list.map((item) => item.attributes.formality))} (n=${list.length})`).join(", "));

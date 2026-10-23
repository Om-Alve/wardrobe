#!/usr/bin/env node
// Runs fixed briefs and the lookbook on each benchmark wardrobe, draws blind random baselines from the same candidates,
// and renders contact sheets plus a grading packet for an independent grader. Output goes to data/bench/<wardrobe>/.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { colorProfile } from "./garment-attributes.mjs";
import { allOutfits } from "./lookbook.mjs";
import { enumerateLooks } from "./outfit-engine.mjs";
import { stylistApi } from "./stylist-api.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
if (existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"));
const bench = path.join(root, "data", "bench");
const BRIEFS = [
  { id: "office", occasion: "Office", conditions: "Mild, 22°C", brief: "A regular weekday at a corporate office." },
  { id: "formal-dinner", occasion: "Formal dinner", conditions: "Cool evening, 18°C", brief: "" },
  { id: "hot-sightseeing", occasion: "Sightseeing", conditions: "Sunny, 33°C", brief: "Walking all day." },
  { id: "rainy-commute", occasion: "Commute", conditions: "Light rain, 14°C", brief: "" },
  { id: "date-night", occasion: "Date night", conditions: "Cool evening, 19°C", brief: "Sharp but not stiff." },
  { id: "weekend-brunch", occasion: "Weekend brunch", conditions: "Warm, 27°C", brief: "" },
  { id: "wedding-guest", occasion: "Wedding guest, western dress", conditions: "Evening, 24°C", brief: "" },
  { id: "gym-errands", occasion: "Gym, then errands", conditions: "Warm, 26°C", brief: "" },
];
const WORN = ["upperbody", "wholebody_up", "lowerbody", "shoes"];
const wardrobes = process.argv.slice(2).length ? process.argv.slice(2) : ["yours", "s", "m", "l"];

function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffled = (list, random) => list.map((entry) => [random(), entry]).sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
const escape = (text) => String(text).replace(/[<>&"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[character]);
const wrap = (text, width) => text.split(" ").reduce((lines, word) => {
  if (lines.length && `${lines.at(-1)} ${word}`.length <= width) lines[lines.length - 1] += ` ${word}`;
  else lines.push(word);
  return lines;
}, []).slice(0, 3);

// One row per look: its label, then each worn piece's photo with its name underneath.
async function renderSheet(rows, imagesDir, file) {
  const width = 150;
  const height = 200;
  const gap = 10;
  const label = 60;
  const rowHeight = height + 52;
  const composites = [];
  for (const [index, row] of rows.entries()) {
    const top = 10 + index * rowHeight;
    composites.push({ input: Buffer.from(`<svg width="${label}" height="${height}" xmlns="http://www.w3.org/2000/svg"><text x="10" y="44" font-size="34" font-family="Helvetica, Arial" font-weight="700">${escape(row.label)}</text></svg>`), left: 0, top });
    for (const [column, piece] of row.pieces.entries()) {
      const left = label + column * (width + gap);
      const photo = await sharp(path.join(imagesDir, path.basename(new URL(piece.image, "http://localhost").pathname))).resize(width, height, { fit: "contain", background: "#ffffff" }).flatten({ background: "#ffffff" }).png().toBuffer();
      composites.push({ input: photo, left, top });
      const lines = wrap(piece.name, 26).map((line, number) => `<text x="2" y="${14 + number * 14}" font-size="12" font-family="Helvetica, Arial">${escape(line)}</text>`).join("");
      composites.push({ input: Buffer.from(`<svg width="${width}" height="48" xmlns="http://www.w3.org/2000/svg">${lines}</svg>`), left, top: top + height + 2 });
    }
  }
  const columns = Math.max(...rows.map((row) => row.pieces.length));
  await sharp({ create: { width: label + columns * (width + gap) + 10, height: rows.length * rowHeight + 20, channels: 3, background: "#f4f4f1" } })
    .composite(composites).png().toFile(file);
}

async function prepareYours() {
  const dir = path.join(bench, "yours");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "library.json"), await readFile(path.join(root, "data", "library.json")));
  if (!existsSync(path.join(dir, "imported"))) await symlink(path.join(root, "data", "imported"), path.join(dir, "imported"));
}

const realFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async (address, options) => {
  if (String(address).endsWith("/chat/completions")) calls += 1;
  return realFetch(address, options);
};

for (const name of wardrobes) {
  if (name === "yours") await prepareYours();
  const dir = path.join(bench, name);
  const library = JSON.parse(await readFile(path.join(dir, "library.json"), "utf8"));
  const byId = new Map(library.map((item) => [item.id, item]));
  await rm(path.join(dir, "stylist.json"), { force: true });
  const grading = path.join(dir, "grading");
  await rm(grading, { recursive: true, force: true });
  await mkdir(grading, { recursive: true });
  const plugin = stylistApi({ env: { WARDROBE_DATA_DIR: path.relative(root, dir) } });
  await plugin.configResolved({ root });
  let handler;
  plugin.configureServer({ middlewares: { use(value) { handler = value; } } });
  const call = async (route, body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { url: `/api/stylist${route}`, method: "POST", headers: {} });
    let status = 0;
    let bytes = "";
    await handler(req, { setHeader() {}, set statusCode(value) { status = value; }, get statusCode() { return status; }, end(value) { bytes += value || ""; } }, () => {});
    return { status, body: JSON.parse(bytes) };
  };
  const random = seeded(name.length * 7919 + library.length);
  const worn = (ids) => WORN.flatMap((part) => ids.map((id) => byId.get(id)).filter((item) => item?.part === part));
  const key = { briefs: {}, lookbook: {} };
  const packet = { wardrobe: name, pieces: library.length, briefs: [], lookbook: null };
  const results = { wardrobe: name, pieces: library.length, briefs: [], lookbook: null };

  for (const brief of BRIEFS) {
    calls = 0;
    const started = Date.now();
    const { status, body } = await call("/suggest", { count: 3, selectedItemIds: library.map((item) => item.id), occasion: brief.occasion, conditions: brief.conditions, brief: brief.brief });
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const looks = status === 201 ? body : [];
    const plan = looks[0]?.plan;
    // The baseline draws from the same candidates the stylist saw: every look that fits its plan, picked at random.
    const pool = plan ? shuffled(enumerateLooks(library, plan).looks, random) : [];
    const baseline = [];
    const same = (first, second) => worn(first).map((item) => item.id).sort().join() === worn(second).map((item) => item.id).sort().join();
    for (const look of pool) {
      if (baseline.length === 3) break;
      // Distinct top and bottom pairs, and never a look the stylist chose, so no two rows on a sheet are the same outfit.
      if (baseline.some((other) => other.ids.slice(0, 2).join() === look.ids.slice(0, 2).join())) continue;
      if (looks.some((chosen) => same(chosen.garmentIds, look.ids))) continue;
      baseline.push(look);
    }
    const entries = shuffled([...looks.map((look) => ({ source: "stylist", ids: look.garmentIds })), ...baseline.map((look) => ({ source: "random", ids: look.ids }))], random);
    const labels = entries.map((_, index) => String.fromCharCode(65 + index));
    key.briefs[brief.id] = Object.fromEntries(entries.map((entry, index) => [labels[index], entry.source]));
    const sheet = path.join(grading, `${brief.id}.png`);
    if (entries.length) await renderSheet(entries.map((entry, index) => ({ label: labels[index], pieces: worn(entry.ids) })), path.join(dir, "imported"), sheet);
    packet.briefs.push({
      id: brief.id, occasion: brief.occasion, conditions: brief.conditions, request: brief.brief, sheet: entries.length ? sheet : null,
      looks: Object.fromEntries(entries.map((entry, index) => [labels[index], worn(entry.ids).map((item) => `${item.name} (${colorProfile(item.color)?.name || "unknown color"})`)])),
    });
    results.briefs.push({
      id: brief.id, status, seconds, modelCalls: calls, error: status === 201 ? null : body.error, plan, gapNotes: looks[0]?.gapNotes || [], candidates: pool.length,
      looks: looks.map((look) => ({ name: look.name, reason: look.reason, garmentIds: look.garmentIds, palette: look.palette?.id || null })),
      itemDiversity: looks.length ? new Set(looks.flatMap((look) => worn(look.garmentIds).map((item) => item.id))).size / looks.flatMap((look) => worn(look.garmentIds)).length : null,
    });
    console.log(`${name} ${brief.id}: HTTP ${status} in ${seconds}s, ${calls} model calls, ${looks.length} looks, ${pool.length} candidates${status === 201 ? "" : ` (${body.error})`}`);
  }

  calls = 0;
  const started = Date.now();
  const { status, body } = await call("/lookbook", {});
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (status === 200) {
    const book = body.lookbook;
    const pickedKeys = new Set(book.outfits.map((outfit) => [...outfit.ids].sort().join()));
    const others = shuffled(allOutfits(library).filter((outfit) => !outfit.note && !pickedKeys.has([...outfit.ids].sort().join())), random).slice(0, 8);
    const picked = shuffled(book.outfits.filter((outfit) => !outfit.note), random).slice(0, 8);
    const entries = shuffled([...picked.map((outfit) => ({ source: "picked", ids: outfit.ids })), ...others.map((outfit) => ({ source: "other", ids: outfit.ids }))], random);
    const halves = [entries.slice(0, 8), entries.slice(8)];
    packet.lookbook = { sheets: [], looks: {} };
    for (const [half, list] of halves.entries()) {
      const sheet = path.join(grading, `lookbook-${half + 1}.png`);
      const rows = list.map((entry, index) => ({ label: String(half * 8 + index + 1), pieces: worn(entry.ids) }));
      await renderSheet(rows, path.join(dir, "imported"), sheet);
      packet.lookbook.sheets.push(sheet);
      for (const [index, entry] of list.entries()) {
        const label = String(half * 8 + index + 1);
        key.lookbook[label] = entry.source;
        packet.lookbook.looks[label] = worn(entry.ids).map((item) => `${item.name} (${colorProfile(item.color)?.name || "unknown color"})`);
      }
    }
    results.lookbook = { seconds, modelCalls: calls, considered: book.considered, picked: book.outfits.length, genres: book.genres.map((genre) => `${genre.name} (${book.outfits.filter((outfit) => outfit.genre === genre.name).length})`), withWada: book.outfits.filter((outfit) => outfit.palette).length };
  } else results.lookbook = { seconds, modelCalls: calls, error: body.error };
  console.log(`${name} lookbook: HTTP ${status} in ${seconds}s, ${calls} model calls${status === 200 ? `, ${results.lookbook.picked} picked of ${results.lookbook.considered}` : ` (${body.error})`}`);

  const reasons = results.briefs.flatMap((brief) => brief.looks.map((look) => ({ brief: brief.id, name: look.name, reason: look.reason, pieces: look.garmentIds.map((id) => byId.get(id)).map((item) => `${item.name} (${item.part}, ${colorProfile(item.color)?.name})`) })));
  await writeFile(path.join(grading, "packet.json"), `${JSON.stringify(packet, null, 2)}\n`);
  await writeFile(path.join(grading, "wardrobe.txt"), library.map((item) => `${item.name} | ${item.part} | ${colorProfile(item.color)?.name || "unknown"}`).join("\n"));
  await writeFile(path.join(grading, "reasons.json"), `${JSON.stringify(reasons, null, 2)}\n`);
  await writeFile(path.join(dir, "key.json"), `${JSON.stringify(key, null, 2)}\n`);
  await writeFile(path.join(dir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
}
globalThis.fetch = realFetch;

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { frameTransparentGarment } from "./import-job-api.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const libraryFile = path.join(root, "data/library.json");
const imageDir = path.join(root, "data/imported");
const backupDir = path.join(root, "data/original-garments");
const reportFile = path.join(root, "data/garment-normalization-report.json");
const args = process.argv.slice(2);
const apply = args.includes("--apply");

if (args.some((arg) => !["--apply", "--help"].includes(arg))) {
  throw new Error("Usage: node scripts/normalize-library-images.mjs [--apply]");
}
if (args.includes("--help")) {
  console.log("Preview by default. Pass --apply to save 1024 x 1024 cutouts and keep the originals in data/original-garments/.");
  process.exit(0);
}

async function bounds(bytes) {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;
  let transparent = 0;
  for (let index = 3, pixel = 0; index < data.length; index += 4, pixel += 1) {
    if (data[index] <= 16) { transparent += 1; continue; }
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  if (right < left) throw new Error("Image contains no visible garment");
  if (!transparent) throw new Error("Image has no transparent background");
  return { canvas: [info.width, info.height], box: [left, top, right - left + 1, bottom - top + 1] };
}

function alreadyFramed({ canvas, box }) {
  const [left, top, width, height] = box;
  return canvas[0] === 1024 && canvas[1] === 1024
    && Math.abs(Math.max(width, height) - Math.round(1024 * 0.88)) <= 2
    && Math.abs(left - ((1024 - width) / 2)) <= 2
    && Math.abs(top - ((1024 - height) / 2)) <= 2;
}

const items = JSON.parse(await readFile(libraryFile, "utf8"));
const records = [];
const versions = new Map();
for (const image of new Set(items.map((item) => item.image))) {
  const pathname = typeof image === "string" ? new URL(image, "http://localhost").pathname : "";
  if (!/^\/api\/import\/library\/[^/]+\.png$/.test(pathname)) {
    records.push({ image, status: "skipped", reason: "Not a local garment PNG" });
    continue;
  }
  const name = path.basename(pathname);
  const file = path.join(imageDir, name);
  try {
    const original = await readFile(file);
    const before = await bounds(original);
    if (alreadyFramed(before)) {
      versions.set(pathname, createHash("sha256").update(original).digest("hex").slice(0, 12));
      records.push({ image, status: "already framed", before });
      continue;
    }
    const framed = await frameTransparentGarment(original);
    const after = await bounds(framed);
    versions.set(pathname, createHash("sha256").update(framed).digest("hex").slice(0, 12));
    if (apply) {
      await mkdir(backupDir, { recursive: true });
      try { await copyFile(file, path.join(backupDir, name), constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      const temporary = `${file}.normalizing`;
      try {
        await writeFile(temporary, framed);
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    }
    records.push({ image, status: apply ? "normalized" : "would normalize", before, after });
  } catch (error) {
    records.push({ image, status: "failed", reason: error.message });
  }
}

if (apply) {
  const versioned = (image) => {
    if (typeof image !== "string") return image;
    const pathname = new URL(image, "http://localhost").pathname;
    return versions.has(pathname) ? `${pathname}?v=${versions.get(pathname)}` : image;
  };
  const updated = items.map((item) => ({ ...item, image: versioned(item.image), thumbnail: versioned(item.thumbnail) }));
  if (JSON.stringify(updated) !== JSON.stringify(items)) {
    await mkdir(backupDir, { recursive: true });
    try { await copyFile(libraryFile, path.join(backupDir, "library.json"), constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const temporary = `${libraryFile}.normalizing`;
    try {
      await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`);
      await rename(temporary, libraryFile);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

const report = { applied: apply, canvas: [1024, 1024], longestDimension: Math.round(1024 * 0.88), records };
if (apply) await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (records.some((record) => record.status === "failed")) process.exitCode = 1;

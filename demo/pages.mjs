#!/usr/bin/env node
// Writes the title and end cards from the wardrobe the demo uses. Garment cutouts arrive one per beat.
// Animations wait for the recorder to add "go" to the body, so they start with the recording.
// Usage: node demo/pages.mjs --data ~/wardrobe-demo/wardrobe/data
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index === -1 ? fallback : args[index + 1]; };
const data = path.resolve(option("data", "data"));
// The title starts with the song, so its first entrance waits for the first beat.
const { beats } = JSON.parse(await readFile(fileURLToPath(new URL("./out/beats.json", import.meta.url)), "utf8"));
const beat = (beats.at(-1) - beats[0]) / (beats.length - 1);
const first = beats[0];
const pages = fileURLToPath(new URL("./out/pages/", import.meta.url));
await mkdir(path.join(pages, "garments"), { recursive: true });

const library = JSON.parse(await readFile(path.join(data, "library.json"), "utf8"));
const order = ["upperbody", "lowerbody", "wholebody_up", "shoes", "accessories_up"];
// Alternate parts so neighbors differ: a top, a bottom, a layer, shoes, an accessory, then around again.
const byPart = order.map((part) => library.filter((item) => item.part === part));
const picks = [];
for (let round = 0; picks.length < 8 && byPart.some((list) => list[round]); round += 1) {
  for (const list of byPart) if (list[round] && picks.length < 8) picks.push(list[round]);
}
const file = (item) => path.basename(new URL(item.image, "http://localhost").pathname);
for (const item of picks) await copyFile(path.join(data, "imported", file(item)), path.join(pages, "garments", file(item)));

const style = `
  @font-face { font-family: "Instrument Sans"; src: url("instrument-sans.woff2") format("woff2"); font-weight: 400 700; }
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; background: #f6f5f0; color: #1f1e1c; font-family: "Instrument Sans", "Helvetica Neue", Arial, sans-serif; overflow: hidden; }
  .card { display: flex; flex-direction: column; align-items: center; gap: 22px; }
  h1 { margin: 0; font-size: 132px; font-weight: 600; letter-spacing: -.045em; line-height: 1; }
  p { margin: 0; color: #6f6b63; font-size: 30px; letter-spacing: -.01em; }
  .rail { display: flex; gap: 18px; margin-top: 40px; height: 150px; }
  .rail img { width: 136px; height: 150px; object-fit: contain; opacity: 0; transform: translateY(18px) scale(.96); animation: in .55s cubic-bezier(.2,.8,.2,1) forwards; }
  .rise { opacity: 0; transform: translateY(14px); animation: in .7s cubic-bezier(.2,.8,.2,1) forwards; }
  @keyframes in { to { opacity: 1; transform: none; } }
  body:not(.go) * { animation-play-state: paused !important; }
`;
const rail = picks.map((item, index) => `<img src="garments/${file(item)}" alt="" style="animation-delay:${(first + beat * (2 + index / 2)).toFixed(3)}s">`).join("");
await writeFile(path.join(pages, "title.html"), `<!doctype html><meta charset="utf-8"><title>Wardrobe</title><style>${style}</style>
<div class="card"><h1 class="rise" style="animation-delay:${first.toFixed(3)}s">Wardrobe</h1><p class="rise" style="animation-delay:${(first + beat).toFixed(3)}s">A stylist for the clothes you already own</p><div class="rail">${rail}</div></div>`);
await writeFile(path.join(pages, "end.html"), `<!doctype html><meta charset="utf-8"><title>Wardrobe</title><style>${style}</style>
<div class="card"><h1 class="rise">Wardrobe</h1><p class="rise" style="animation-delay:${beat.toFixed(3)}s">Built from your camera roll and styled from your wardrobe</p></div>`);
console.log(`Title rail: ${picks.map((item) => item.name).join(", ")}`);

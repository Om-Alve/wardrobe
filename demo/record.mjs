#!/usr/bin/env node
// Records each scene of the demo against a running copy of the app.
// Usage: node demo/record.mjs --url http://localhost:5199 [--only planner,lookbook] [--no-tryon]
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Director } from "./lib/director.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index === -1 ? fallback : args[index + 1]; };
const url = option("url", "http://localhost:5199");
const pages = option("pages", "http://127.0.0.1:5299");
const out = path.resolve(option("out", fileURLToPath(new URL("./out/scenes", import.meta.url))));
const only = option("only", "")?.split(",").filter(Boolean);
const tryOn = !args.includes("--no-tryon");
await mkdir(out, { recursive: true });

const d = new Director({ session: option("session", "wardrobe-demo"), out });
const nav = (name) => d.byText(name, { within: "nav[aria-label='Main navigation']" });
const looks = ".stylist-look";

// Waits for the new draft looks rather than any looks already on the page.
async function suggest() {
  const before = await d.eval(`document.querySelectorAll(${JSON.stringify(looks)}).length`);
  await d.click(await d.byText("Suggest outfits"), { mark: "suggest" });
  await d.waitFor(`(() => { const error = document.querySelector(".stylist-alert.error"); if (error) throw new Error(error.innerText); return document.querySelectorAll(${JSON.stringify(looks)}).length > ${before} && !document.querySelector(".stylist-progress-heading"); })()`);
}

async function field(selector, text, options = {}) {
  await d.click(await d.box(selector), { after: 150, ...options });
  await d.type(text);
}

// A page scene: open it, start the recording, then let it play.
async function page(name, file, play) {
  await d.setup(`${pages}/${file}`);
  await d.pause(0.8);
  await d.startRecording(name, { cursor: false });
  await play();
  return d.stopRecording({ tail: 0.4 });
}

const scenes = {
  title: () => page("title", "title.html", async () => {
    await d.eval(`document.body.classList.add("go")`);
    d.mark("start");
    await d.pause(6.4);
  }),

  roll: () => page("roll", "camera-roll.html", async () => {
    d.mark("start");
    await d.pause(0.4);
    await d.eval(`new Promise((done) => { const el = document.scrollingElement, y1 = el.scrollHeight - innerHeight, t0 = performance.now(), d = 5200; const e = (t) => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; const step = (t) => { const p = Math.min(1, (t - t0) / d); el.scrollTop = y1 * e(p); p < 1 ? requestAnimationFrame(step) : done(1); }; requestAnimationFrame(step); })`);
    d.mark("bottom");
    await d.pause(0.4);
  }),

  terminal: () => page("terminal", "terminal.html", async () => {
    await d.waitFor(`window.player && document.querySelector(".ap-terminal")`, { timeout: 30000 });
    await d.eval(`window.player.play()`);
    d.mark("play");
    await d.waitFor(`(async () => (await window.player.getCurrentTime()) >= window.castDuration - 0.05)()`, { timeout: 120000, interval: 200 });
    d.mark("played");
    await d.pause(0.6);
  }),

  end: () => page("end", "end.html", async () => {
    await d.eval(`document.body.classList.add("go")`);
    d.mark("start");
    await d.pause(5.6);
  }),

  async wardrobe() {
    await d.setup(url);
    await d.startRecording("wardrobe");
    await d.pause(1.2);
    d.mark("start");
    await d.click(await d.byText("Tops"), { mark: "tops" });
    await d.pause(0.5);
    await d.click(await d.byText("Bottoms"), { mark: "bottoms" });
    await d.pause(0.5);
    await d.click(await d.byText("Shoes"), { mark: "shoes" });
    await d.pause(0.5);
    await d.click(await d.byText("All"), { mark: "all" });
    await d.pause(0.7);
    await d.click(await d.box("[aria-label^='View ']", { nth: 1 }), { mark: "open" });
    await d.pause(1.6);
    d.mark("photo");
    await d.scrollIntoView(".viewer .style-field", { container: ".viewer", block: "start", offset: 40, duration: 1.1 });
    d.mark("style");
    await d.pause(2.6);
    await d.click(await d.box("[aria-label='Close viewer']"), { mark: "close" });
    await d.pause(0.6);
    return d.stopRecording();
  },

  async profile() {
    await d.setup(url);
    await d.startRecording("profile");
    await d.pause(0.6);
    await d.click(await nav("Profile"), { mark: "start" });
    await d.pause(1);
    await d.click(await d.byText("Suggest from my photo"), { mark: "suggest" });
    await d.waitFor(`document.querySelector(".profile-photo-note")`, { timeout: 120000 });
    d.mark("suggested");
    await d.pause(1.8);
    await d.scrollIntoView("input[placeholder='No black with navy']", { duration: 1 });
    await field("input[placeholder='No black with navy']", "No shorts at dinner");
    d.mark("rule");
    await d.pause(0.5);
    await d.click(await d.byText("Save", { within: ".profile-actions" }), { mark: "save" });
    await d.pause(1.2);
    return d.stopRecording();
  },

  async planner() {
    await d.setup(url);
    await d.startRecording("planner");
    await d.pause(0.6);
    await d.click(await nav("Planner"), { mark: "start" });
    await d.pause(0.8);
    await field("input[placeholder^='Dinner, sightseeing']", "Dinner with friends", { mark: "occasion" });
    await field("input[placeholder^='Warm days']", "24°C, clear evening");
    await field("textarea[placeholder^='I want relaxed']", "Relaxed but put together.");
    await d.pause(0.3);
    await suggest();
    d.mark("results");
    await d.scrollIntoView(looks, { block: "start", offset: 150, duration: 1.2 });
    d.mark("reasons");
    await d.pause(3);
    await d.click(await d.box(`${looks} [aria-label='Good look']`), { mark: "thumbs" });
    await d.pause(0.8);
    await d.scrollIntoView(looks, { nth: 1, duration: 0.9 });
    await d.click(await d.byText("Revise", { within: `${looks}:nth-of-type(2)` }), { mark: "revise-open" });
    await d.pause(0.3);
    await d.type("Something warmer for later");
    await d.pause(0.3);
    await d.click(await d.box(".stylist-revise-form button[type=submit]"), { mark: "revise" });
    await d.waitFor(`document.querySelector(".stylist-chat-history") && !document.querySelector(".stylist-revise-form")`);
    d.mark("revised");
    await d.pause(2.4);
    await d.click(await d.byText("Save outfit", { within: `${looks}:nth-of-type(2)` }), { mark: "save" });
    // Saving opens Outfits › Saved, where the look waits in a collapsed row.
    await d.waitFor(`document.querySelector(".stylist-saved-row")`);
    await d.pause(1);
    if (tryOn) {
      await d.click(await d.box(".stylist-saved-row summary"), { mark: "open-saved" });
      await d.pause(0.6);
      await d.click(await d.byText("See how it looks", { within: ".stylist-saved-row[open]" }), { mark: "photo" });
      await d.waitFor(`document.querySelector(".stylist-saved-row .stylist-look-photo")`, { timeout: 600000, interval: 1000 });
      d.mark("photo-ready");
      await d.pause(0.4);
      await d.scrollIntoView(".stylist-saved-row .stylist-look-photo", { duration: 1 });
      await d.pause(2.8);
    }
    return d.stopRecording();
  },

  async trip() {
    await d.setup(url);
    await d.click(await nav("Planner"));
    await d.pause(1);
    await d.startRecording("trip");
    await d.pause(0.6);
    await d.click(await d.byText("New trip"), { mark: "start" });
    await d.pause(0.5);
    await field("input[placeholder='Kyoto in autumn']", "Lisbon");
    await field("input[placeholder='Kyoto, Japan']", "Lisbon, Portugal");
    await d.click(await d.byText("Create trip"), { mark: "created" });
    await d.waitFor(`document.querySelector(".stylist-pack-list select")`);
    await d.pause(0.6);
    await d.scrollIntoView(".stylist-pack-list", { block: "start", offset: 120, duration: 1 });
    // A small, complete suitcase: tops, bottoms, shoes and a layer.
    const rows = await d.eval(`[...document.querySelectorAll(".stylist-pack-row")].map((row) => ({ label: row.querySelector("select").getAttribute("aria-label"), part: row.querySelector("small").innerText }))`);
    const quota = { Tops: 2, Bottoms: 2, Shoes: 1, Layers: 1 };
    const names = rows.filter((row) => quota[row.part]-- > 0).map((row) => row.label);
    d.mark("packing");
    for (const label of names) {
      const selector = `select[aria-label=${JSON.stringify(label)}]`;
      await d.moveTo(await d.box(selector), { duration: 0.3 });
      await d.ab("select", selector, "packed");
      await d.pause(0.15);
    }
    d.mark("packed");
    await d.scrollIntoView(".stylist-ask", { block: "start", duration: 1.1 });
    await d.click(await d.byText("Check destination weather"), { mark: "weather" });
    await d.waitFor(`document.querySelector(".stylist-weather-row span")`, { timeout: 30000 });
    d.mark("forecast");
    await d.pause(1.2);
    await field("input[placeholder^='Dinner, sightseeing']", "Sightseeing all day");
    await suggest();
    d.mark("results");
    await d.scrollIntoView(looks, { block: "start", offset: 150, duration: 1.2 });
    await d.pause(2.6);
    return d.stopRecording();
  },

  async lookbook() {
    await d.setup(url);
    await d.click(await nav("Outfits"));
    await d.waitFor(`document.querySelectorAll(".lookbook-tile").length && !document.querySelector(".lookbook.is-building")`, { timeout: 600000, interval: 2000 });
    await d.click(await nav("Clothes"));
    await d.pause(0.8);
    await d.startRecording("lookbook");
    await d.pause(0.5);
    await d.click(await nav("Outfits"), { mark: "start" });
    await d.pause(1.4);
    await d.scrollIntoView(".lookbook-section", { block: "start", offset: 110, duration: 1.2 });
    d.mark("genre-1");
    await d.pause(1.6);
    await d.moveTo(await d.box(".lookbook-palette", { nth: 0 }), { duration: 0.6 });
    d.mark("swatches");
    await d.pause(1.6);
    await d.scrollBy(520, { duration: 1.4 });
    d.mark("genre-2");
    await d.pause(1.2);
    await d.scrollIntoView(".lookbook-genres", { block: "start", offset: 120, duration: 1.1 });
    await d.click(await d.box(".lookbook-genres button", { nth: 2 }), { mark: "filter" });
    await d.pause(1.2);
    await d.click(await d.box(".lookbook-tile [aria-label='Save outfit']", { nth: 0 }), { mark: "saved" });
    await d.pause(0.8);
    await d.click(await d.byText("Saved", { within: "nav[aria-label='Outfit views']" }), { mark: "saved-tab" });
    await d.pause(2);
    return d.stopRecording();
  },

  async buy() {
    await d.setup(url);
    await d.startRecording("buy");
    await d.pause(0.5);
    await d.click(await d.byText("What to buy next"), { mark: "start" });
    await d.pause(1.2);
    await field("input[aria-label='Add an occasion']", "Office days");
    await d.ab("press", "Enter");
    await d.pause(0.5);
    await d.click(await d.byText("Find what to buy"), { mark: "run" });
    await d.pause(1);
    await d.waitFor(`document.querySelector(".buy-coverage") && ![...document.querySelectorAll("button")].some((b) => b.innerText.startsWith("Comparing"))`, { timeout: 300000, interval: 1000 });
    d.mark("results");
    await d.pause(1.2);
    await d.scrollIntoView(".buy-coverage", { block: "start", offset: 110, duration: 1.2 });
    d.mark("coverage");
    await d.pause(1.6);
    await d.scrollIntoView(".stylist-results", { block: "start", offset: 110, duration: 1.2 });
    d.mark("ranked");
    await d.pause(3);
    await d.scrollBy(600, { duration: 1.6 });
    await d.pause(1.6);
    return d.stopRecording();
  },
};

for (const [name, scene] of Object.entries(scenes)) {
  if (only?.length && !only.includes(name)) continue;
  const started = Date.now();
  const result = await scene();
  console.log(`${name}: ${result.duration.toFixed(1)}s recorded in ${((Date.now() - started) / 1000).toFixed(0)}s; marks ${Object.keys(result.marks).join(", ")}`);
}

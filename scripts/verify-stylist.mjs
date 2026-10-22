#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { stylistApi } from "./stylist-api.mjs";
import { relevantPalettes } from "./stylist-core.mjs";

const workspace = await mkdtemp(path.join(tmpdir(), "wardrobe-stylist-"));
const realFetch = globalThis.fetch;
let handler;
let imageCalls = 0;
let responseCalls = 0;
let returnInvalidFirst = true;
let failNextSuggestion = false;

const topId = randomUUID();
const otherTopId = randomUUID();
const bottomId = randomUUID();
const shoeId = randomUUID();
const items = [
  { id: topId, name: "Olive shirt", part: "upperbody", color: "#53694e", tags: ["cotton"] },
  { id: otherTopId, name: "Burgundy shirt", part: "upperbody", color: "#71374f", tags: ["linen"] },
  { id: bottomId, name: "Black trousers", part: "lowerbody", color: "#202024", tags: ["formal"] },
  { id: shoeId, name: "Blue shoes", part: "shoes", color: "#3b5262", tags: ["sneakers"] },
];
const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: "#53694e" } }).png().toBuffer();
const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

function fakeJson(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

async function invoke(route, method = "GET", data, headers = {}) {
  const req = Readable.from(data ? [Buffer.from(JSON.stringify(data))] : []);
  req.url = `/api/stylist${route}`;
  req.method = method;
  req.headers = headers;
  let status = 200;
  let bytes = Buffer.alloc(0);
  let headersSent = false;
  const responseHeaders = {};
  const res = {
    setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
    get headersSent() { return headersSent; },
    flushHeaders() { headersSent = true; },
    write(value) { headersSent = true; bytes = Buffer.concat([bytes, Buffer.from(value)]); },
    get statusCode() { return status; },
    set statusCode(value) { status = value; },
    end(value) { headersSent = true; if (value) bytes = Buffer.concat([bytes, Buffer.from(value)]); },
  };
  await handler(req, res, () => { throw new Error(`Unmatched route: ${route}`); });
  return {
    status,
    body: route.startsWith("/images/") && status === 200 ? bytes
      : responseHeaders["content-type"]?.includes("application/x-ndjson")
        ? bytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line))
        : JSON.parse(bytes.toString("utf8")),
  };
}

async function waitForPhoto(id) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = (await invoke("/state")).body;
    const look = state.looks.find((entry) => entry.id === id);
    if (look?.status !== "generating") return look;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Photo generation did not finish.");
}

try {
  const dataDir = path.join(workspace, "data");
  const importedDir = path.join(dataDir, "imported");
  await mkdir(importedDir, { recursive: true });
  for (const item of items) {
    item.image = `/api/import/library/${item.id}-garment.png`;
    await writeFile(path.join(importedDir, `${item.id}-garment.png`), png);
  }
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify(items));
  await writeFile(path.join(dataDir, "model-reference.png"), png);
  assert.equal(relevantPalettes(items).length, 10);

  globalThis.fetch = async (address, options) => {
    const url = String(address);
    if (url.includes("geocoding-api.open-meteo.com")) {
      return fakeJson({ results: [{ name: "Kyoto", country: "Japan", latitude: 35, longitude: 135 }] });
    }
    if (url.includes("api.open-meteo.com")) {
      return fakeJson({ daily: {
        time: [today, tomorrow],
        temperature_2m_min: [14, 16], temperature_2m_max: [22, 24],
        precipitation_probability_max: [20, 40],
      } });
    }
    if (url.endsWith("/chat/completions")) {
      responseCalls += 1;
      if (failNextSuggestion) {
        failNextSuggestion = false;
        throw new DOMException("The operation timed out.", "TimeoutError");
      }
      assert.equal(options.headers.Authorization, url.startsWith("http://localhost:11434") ? undefined : "Bearer stylist-key");
      const body = JSON.parse(options.body);
      const prompt = body.messages[0].content;
      let answer;
      if (prompt.startsWith("You are a practical personal stylist planning outfits")) {
        answer = JSON.stringify({ plan: { formality: [1, 5], maxWarmth: null, outerLayer: "optional", layerMaxWarmth: null, include: [], exclude: [] } });
      } else if (prompt.startsWith("Revise this look")) {
        answer = JSON.stringify({ change: null, pieces: ["T1", "B1", "S1"], name: "Revised Kyoto look", reason: "Olive and blue work with a restrained dark base." });
      } else {
        const look = returnInvalidFirst ? "L99" : prompt.match(/^(L\d+):/m)[1];
        returnInvalidFirst = false;
        answer = JSON.stringify({ picks: [{ look, accessories: [], name: "Kyoto walking look", reason: "Olive and blue work with a restrained dark base." }] });
      }
      if (body.stream) {
        const midpoint = Math.floor(answer.length / 2);
        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "considering colors" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(0, midpoint) } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: answer.slice(midpoint) } }] })}\n\n`,
          "data: [DONE]\n\n",
        ];
        return new Response(new ReadableStream({ start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        } }), { headers: { "Content-Type": "text/event-stream" } });
      }
      return fakeJson({ choices: [{ message: { content: answer } }] });
    }
    if (url.endsWith("/images/edits")) {
      imageCalls += 1;
      assert.equal(options.headers.Authorization, "Bearer image-key");
      assert.ok(options.body instanceof FormData);
      assert.equal([...options.body.keys()].filter((key) => key === "image[]").length, 4);
      return fakeJson({ data: [{ b64_json: png.toString("base64") }] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const plugin = stylistApi({ env: { WARDROBE_LLM_API_KEY: "stylist-key", OPENAI_IMAGE_API_KEY: "image-key", WARDROBE_DATA_DIR: "data" } });
  await plugin.configResolved({ root: workspace });
  plugin.configureServer({ middlewares: { use(value) { handler = value; } } });

  const created = await invoke("/trips", "POST", { name: "Kyoto", destination: "Kyoto, Japan", startDate: today, endDate: tomorrow });
  assert.equal(created.status, 201);
  const tripId = created.body.id;
  const packed = { [topId]: "packed", [otherTopId]: "planned", [bottomId]: "packed", [shoeId]: "worn" };
  assert.equal((await invoke(`/trips/${tripId}`, "PATCH", { items: packed })).status, 200);
  const forecast = await invoke(`/weather?destination=Kyoto&startDate=${today}&endDate=${tomorrow}`);
  assert.match(forecast.body.summary, /14–24°C/);

  const forbiddenSelection = await invoke("/suggest", "POST", { tripId, count: 1, selectedItemIds: [otherTopId, bottomId] });
  assert.equal(forbiddenSelection.status, 400);
  const suggested = await invoke("/suggest", "POST", { tripId, count: 1, selectedItemIds: [topId, bottomId, shoeId], occasion: "Sightseeing", anchorId: topId });
  assert.equal(suggested.status, 201, JSON.stringify(suggested.body));
  assert.equal(responseCalls, 3, "A plan call, then a pick of an unlisted candidate should force one retry.");
  const look = suggested.body[0];
  assert.deepEqual(look.garmentIds, [topId, bottomId, shoeId]);
  assert.equal(look.warnings[0].itemId, shoeId);
  assert.equal(look.status, "idea");
  assert.equal(imageCalls, 0, "Suggestions must not make a photo.");

  returnInvalidFirst = true;
  const streamed = await invoke("/suggest", "POST", { tripId, count: 1, selectedItemIds: [topId, bottomId, shoeId], anchorId: topId }, { accept: "application/x-ndjson" });
  assert.equal(streamed.status, 200);
  assert.deepEqual(streamed.body.map((event) => event.stage).filter(Boolean), ["preparing", "weather", "plan", "candidates", "model", "thinking", "responding", "checking", "retrying", "thinking", "responding", "checking", "saving"]);
  assert.equal(streamed.body.at(-1).type, "done");
  assert.equal(streamed.body.at(-1).looks[0].garmentIds[0], topId);
  assert.equal(imageCalls, 0);

  failNextSuggestion = true;
  const timedOut = await invoke("/suggest", "POST", { tripId, count: 1, selectedItemIds: [topId, bottomId] }, { accept: "application/x-ndjson" });
  assert.equal(timedOut.status, 200);
  assert.deepEqual(timedOut.body.map((event) => event.stage).filter(Boolean), ["preparing", "weather", "plan"]);
  assert.equal(timedOut.body.at(-1).type, "error");
  assert.match(timedOut.body.at(-1).message, /more than five minutes/);

  const revised = await invoke(`/looks/${look.id}/revise`, "POST", { message: "Keep it suitable for walking." });
  assert.equal(revised.status, 200);
  assert.equal(revised.body.name, "Revised Kyoto look");
  assert.equal(revised.body.messages.length, 2);

  const saved = await invoke(`/looks/${look.id}/save`, "POST");
  assert.equal(saved.status, 200);
  assert.ok(saved.body.savedAt, "A combination can be saved without a photo.");
  assert.equal(imageCalls, 0);

  const started = await invoke(`/looks/${look.id}/photo`, "POST");
  assert.equal(started.status, 202);
  const ready = await waitForPhoto(look.id);
  assert.equal(ready.status, "review", ready.error);
  assert.ok(ready.savedAt);
  assert.equal(imageCalls, 1);
  const image = await invoke(`/images/${look.id}.png`);
  assert.deepEqual(image.body, png);

  const scheduled = await invoke(`/looks/${look.id}`, "PATCH", { date: tomorrow });
  assert.equal(scheduled.body.date, tomorrow);
  const persisted = JSON.parse(await readFile(path.join(dataDir, "stylist.json"), "utf8"));
  assert.equal(persisted.looks[0].savedAt, saved.body.savedAt);

  packed[topId] = "planned";
  await invoke(`/trips/${tripId}`, "PATCH", { items: packed });
  const disallowed = await invoke(`/looks/${look.id}/photo`, "POST");
  assert.equal(disallowed.status, 409);
  assert.match(disallowed.body.error, /no longer packed/);

  assert.equal((await invoke(`/trips/${tripId}`, "DELETE")).status, 200);
  const final = (await invoke("/state")).body;
  assert.equal(final.trips.length, 0);
  assert.equal(final.looks.length, 0);

  const localPlugin = stylistApi({ env: { WARDROBE_LLM_BASE_URL: "http://localhost:11434/v1", WARDROBE_LLM_MODEL: "local-text-model", WARDROBE_DATA_DIR: "data" } });
  await localPlugin.configResolved({ root: workspace });
  localPlugin.configureServer({ middlewares: { use(value) { handler = value; } } });
  const localState = (await invoke("/state")).body;
  assert.equal(localState.setup.hasLlm, true);
  assert.equal(localState.setup.hasImageKey, false);
  const localLooks = await invoke("/suggest", "POST", { count: 1, selectedItemIds: [topId, bottomId, shoeId] });
  assert.equal(localLooks.status, 201, JSON.stringify(localLooks.body));
  const localSaved = await invoke(`/looks/${localLooks.body[0].id}/save`, "POST");
  assert.equal(localSaved.status, 200);
  assert.ok(localSaved.body.savedAt);
  assert.equal((await invoke(`/looks/${localLooks.body[0].id}/photo`, "POST")).status, 422);
  console.log("Stylist flow verified: distinct keys, keyless local LLM, trip states, revision, saved look, optional photo, scheduling, and deletion.");
} finally {
  globalThis.fetch = realFetch;
  await rm(workspace, { recursive: true, force: true });
}

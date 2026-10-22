#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { profileApi } from "./profile-api.mjs";
import { profileScore, profileSummary } from "./profile.mjs";

const workspace = await mkdtemp(path.join(tmpdir(), "wardrobe-profile-"));
const realFetch = globalThis.fetch;
let handler;
let sentImage = null;
let prompt = "";

async function invoke(route, method = "GET", data) {
  const req = Readable.from(data ? [Buffer.from(JSON.stringify(data))] : []);
  Object.assign(req, { url: `/api/profile${route}`, method, headers: {} });
  let status = 200;
  let bytes = "";
  const res = {
    setHeader() {},
    get statusCode() { return status; },
    set statusCode(value) { status = value; },
    end(value) { bytes += value || ""; },
  };
  await handler(req, res, () => { throw new Error(`Unmatched route ${route}`); });
  return { status, body: JSON.parse(bytes) };
}

const piece = (part, color, secondaryColor) => ({ id: `${part}-${color}`, name: `${part} ${color}`, part, color, secondaryColor });
const look = (...pieces) => ({ ids: pieces.map((item) => item.id), pieces });

try {
  const dataDir = path.join(workspace, "data");
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, "model-reference.png"), await sharp({ create: { width: 1800, height: 2400, channels: 3, background: "#a07e56" } }).png().toBuffer());

  globalThis.fetch = async (address, options) => {
    assert.equal(String(address), "https://llm.example/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer profile-key");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "configured-vision-model", "The configured model reads the photo.");
    const [text, image] = body.messages[0].content;
    prompt = text.text;
    const [, mime, data] = image.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
    sentImage = { mime, ...await sharp(Buffer.from(data, "base64")).metadata() };
    // A careless answer: confident undertone in warm light, an out-of-range value, and body fields the app must not keep.
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      hairLightness: { value: "dark", confidence: "high" },
      contrast: { value: "high", confidence: "medium" },
      skinDepth: { value: 6, confidence: "medium" },
      undertone: { value: "warm", confidence: "high" },
      greyHair: { value: false, confidence: "high" },
      hairColor: { value: "black", confidence: "high" },
      weightKg: { value: 80, confidence: "low" },
      bodyShape: { value: "athletic", confidence: "low" },
      photo: { framing: "waist-up", lighting: "warm", frontView: true },
    }) } }] }), { headers: { "Content-Type": "application/json" } });
  };
  const plugin = profileApi({ env: { WARDROBE_LLM_API_KEY: "profile-key", WARDROBE_LLM_BASE_URL: "https://llm.example/v1", WARDROBE_LLM_MODEL: "configured-vision-model", WARDROBE_DATA_DIR: "data" } });
  await plugin.configResolved({ root: workspace });
  plugin.configureServer({ middlewares: { use(value) { handler = value; } } });

  const empty = await invoke("");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { profile: { enabled: true, source: {} }, hasReference: true, hasLlm: true });

  const suggested = await invoke("/suggest", "POST");
  assert.equal(suggested.status, 200, JSON.stringify(suggested.body));
  assert.equal(sentImage.mime, "image/jpeg");
  assert.ok(Math.max(sentImage.width, sentImage.height) <= 1024, "The photo is downscaled before it is sent.");
  assert.match(prompt, /Do not estimate weight, body size/);
  assert.match(prompt, /Under warm or mixed light, undertone confidence must be low/);
  const { suggestion, confidence, photo, note } = suggested.body;
  assert.deepEqual(suggestion, { hairLightness: "dark", contrast: "high", skinDepth: 6, undertone: "warm", greyHair: false, undertoneConfidence: "low" },
    "Only profile fields come back, never body or weight fields.");
  assert.equal(confidence.undertone, "low", "Warm light caps undertone confidence even when the model claims more.");
  assert.deepEqual(photo, { framing: "waist-up", lighting: "warm", frontView: true });
  assert.match(note, /^Waist-up photo in warm light: undertone is uncertain/);
  await assert.rejects(stat(path.join(dataDir, "profile.json")), { code: "ENOENT" }, "Suggestions are not saved.");
  assert.deepEqual((await invoke("")).body.profile, { enabled: true, source: {} });

  const photoSources = Object.fromEntries(Object.keys(suggestion).map((key) => [key, "photo"]));
  const put = await invoke("", "PUT", {
    ...suggestion, source: { ...photoSources, skinDepth: "user", heightCm: "photo" },
    skinDepth: 7, heightCm: 178, goals: "look taller; I weigh 80 kg", lovedColors: ["Olive", "burgundy", "olive"],
    avoidedColors: ["yellow"], avoidNearFace: true, rules: "no black with navy.",
    weightKg: 80, waist: 32, bmi: 24.5, bodyType: "athletic", fit: "baggy", undertoneConfidence: "certain",
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const saved = JSON.parse(await readFile(path.join(dataDir, "profile.json"), "utf8"));
  assert.deepEqual(saved, put.body.profile);
  for (const key of ["weightKg", "waist", "bmi", "bodyType", "fit", "undertoneConfidence"]) assert.ok(!(key in saved), `${key} is dropped.`);
  assert.equal(saved.goals, "look taller; I weigh", "Measurements typed into free text are dropped.");
  assert.deepEqual(saved.lovedColors, ["olive", "burgundy"]);
  assert.deepEqual(saved.source, {
    hairLightness: "photo", contrast: "photo", skinDepth: "user", undertone: "photo", greyHair: "photo",
    heightCm: "user", goals: "user", lovedColors: "user", avoidedColors: "user", avoidNearFace: "user", rules: "user",
  }, "Photo fields keep their source; anything the user set or changed is the user's, and only photo fields can come from the photo.");

  // A client that sends no sources: unchanged fields keep theirs, changed fields become the user's.
  const edited = await invoke("", "PUT", { ...saved, source: undefined, contrast: "medium", undertoneConfidence: "high", fit: "relaxed" });
  assert.equal(edited.body.profile.source.contrast, "user");
  assert.equal(edited.body.profile.source.hairLightness, "photo");
  assert.equal(edited.body.profile.source.undertoneConfidence, "user");
  assert.equal(edited.body.profile.source.fit, "user");
  const final = await invoke("", "PUT", { ...edited.body.profile, contrast: "high", source: { ...edited.body.profile.source, contrast: "user" } });
  const loaded = await invoke("");
  assert.deepEqual(loaded.body.profile, final.body.profile, "GET returns the saved profile.");
  const profile = loaded.body.profile;

  const white = piece("upperbody", "#f5f5f2");
  const black = piece("lowerbody", "#141414");
  const grey = piece("upperbody", "#8a8d90");
  const darkGrey = piece("lowerbody", "#55585c");
  const crisp = profileScore(look(white, black), profile);
  const soft = profileScore(look(grey, darkGrey), profile);
  assert.ok(crisp.score > soft.score, "A high-contrast profile prefers a high-contrast look.");
  assert.ok(soft.score < 0 && crisp.score > 0);
  assert.ok(crisp.notes.includes("suits your high contrast") && soft.notes.includes("lower contrast than your coloring"));
  const low = { ...profile, contrast: "low" };
  assert.ok(profileScore(look(white, black), low).score < profileScore(look(grey, darkGrey), low).score, "A low-contrast profile reverses the preference.");

  const navy = piece("lowerbody", "#1d2840");
  const yellowTop = piece("upperbody", "#ecd04b");
  const yellowShoes = piece("shoes", "#ecd04b");
  const cream = piece("upperbody", "#efe3c4");
  const avoider = { enabled: true, avoidedColors: ["yellow"], source: {} };
  const onTop = profileScore(look(yellowTop, navy), avoider);
  const onShoes = profileScore(look(cream, navy, yellowShoes), avoider);
  assert.ok(onTop.score < onShoes.score && onShoes.score < 0, "An avoided color costs more near the face than on shoes.");
  assert.ok(onTop.notes.includes("avoided yellow near the face"));
  assert.equal(profileScore(look(cream, navy, yellowShoes), { ...avoider, avoidNearFace: true }).score, 0, "Away from the face it costs nothing when the wearer says so.");

  const rust = piece("upperbody", "#a5502e");
  const guessed = { enabled: true, undertone: "warm", undertoneConfidence: "low", source: { undertone: "photo" } };
  assert.equal(profileScore(look(rust, navy), guessed).score, 0, "A low-confidence photo undertone has no effect.");
  assert.ok(profileScore(look(rust, navy), { ...guessed, source: { undertone: "user" } }).score > 0, "A confirmed undertone nudges.");

  const off = { ...profile, enabled: false };
  assert.deepEqual(profileScore(look(white, black), off), { score: 0, notes: [] });
  assert.deepEqual(profileScore(look(white, black), { enabled: true, source: {} }), { score: 0, notes: [] });
  for (const extreme of [look(grey, darkGrey, piece("wholebody_up", "#ecd04b")), look(white, black, piece("shoes", "#6b6d3a"))]) {
    const { score } = profileScore(extreme, { ...profile, avoidedColors: ["yellow", "grey"], lovedColors: ["olive", "white", "black"] });
    assert.ok(score >= -0.2 && score <= 0.1, "The profile only nudges.");
  }

  assert.equal(profileSummary(off), "");
  assert.equal(profileSummary({ enabled: true, source: {} }), "");
  const summary = profileSummary(profile);
  for (const part of [/high personal contrast \(dark hair\)/, /Monk skin depth 7/, /warm undertone/, /relaxed fits/, /look taller/, /avoids yellow near the face/, /no black with navy/]) assert.match(summary, part);
  assert.doesNotMatch(summary, /\d{3}|cm|kg|80/, "Height and weight never reach the model as numbers.");
  assert.doesNotMatch(profileSummary({ ...profile, undertoneConfidence: "low" }), /undertone/, "An unconfirmed, uncertain undertone stays out of the prompt.");
  console.log(`Profile verified: suggestion without saving, forbidden and invalid fields dropped, sources, contrast and avoided-color nudges, undertone gate, disabled profile.\n${summary}`);
} finally {
  globalThis.fetch = realFetch;
  await rm(workspace, { recursive: true, force: true });
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { eligibleItems, PACK_STATES, relevantPalettes, validateLook, warningsFor } from "./stylist-core.mjs";
import { chatJson, imageSettings, llmSettings } from "./llm-client.mjs";

const BASE = "/api/stylist";
const EMPTY = { version: 1, trips: [], looks: [] };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function send(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(value));
}

async function input(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw bad("Request is too large.", 413);
    chunks.push(chunk);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
  catch { throw bad("Expected JSON."); }
}

function field(value, limit = 200) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function dateField(value) {
  return typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(value)) ? value : "";
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return structuredClone(fallback); throw error; }
}

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

async function requestLooks({ key, baseUrl, model, prompt, count }) {
  let parsed;
  try {
    parsed = await chatJson({ key, baseUrl, model, prompt: `${prompt}\nReturn JSON in this exact shape: {"looks":[{"name":"...","reason":"...","occasion":"...","garmentIds":["item-id"],"paletteId":1}]}. Include exactly ${count} looks.` });
  } catch (error) {
    throw bad(`The LLM could not suggest outfits: ${error.message}`, 502);
  }
  if (!Array.isArray(parsed.looks) || parsed.looks.length !== count) throw bad("The LLM returned the wrong number of looks.", 502);
  return parsed.looks;
}

async function requestPhoto({ key, baseUrl, model, quality, prompt, images }) {
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set("quality", quality);
  form.set("size", "1024x1536");
  form.set("output_format", "png");
  for (const [index, image] of images.entries()) {
    const normalized = await sharp(image.data).rotate().toColorspace("srgb").png().toBuffer();
    form.append("image[]", new Blob([normalized], { type: "image/png" }), image.name || `reference-${index}.png`);
  }
  const response = await fetch(`${baseUrl}/images/edits`, {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
    signal: AbortSignal.timeout(300000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw bad(result.error?.message || `OpenAI image request failed (${response.status}).`, 502);
  if (!result.data?.[0]?.b64_json) throw bad("OpenAI returned no photo.", 502);
  return Buffer.from(result.data[0].b64_json, "base64");
}

export async function forecastFor(destination, startDate = "", endDate = "") {
  if (!destination) return null;
  const search = new URL("https://geocoding-api.open-meteo.com/v1/search");
  search.searchParams.set("name", destination);
  search.searchParams.set("count", "1");
  search.searchParams.set("language", "en");
  const placeResponse = await fetch(search, { signal: AbortSignal.timeout(8000) });
  if (!placeResponse.ok) throw bad("Could not find the trip destination.", 502);
  const place = (await placeResponse.json()).results?.[0];
  if (!place) return null;
  const forecast = new URL("https://api.open-meteo.com/v1/forecast");
  forecast.searchParams.set("latitude", String(place.latitude));
  forecast.searchParams.set("longitude", String(place.longitude));
  forecast.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max");
  forecast.searchParams.set("timezone", "auto");
  forecast.searchParams.set("forecast_days", "16");
  const response = await fetch(forecast, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw bad("Weather forecast is unavailable.", 502);
  const daily = (await response.json()).daily;
  const days = daily?.time?.map((date, index) => ({
    date, low: daily.temperature_2m_min[index], high: daily.temperature_2m_max[index],
    rain: daily.precipitation_probability_max[index],
  })).filter((day) => (!startDate || day.date >= startDate) && (!endDate || day.date <= endDate)) || [];
  if (!days.length) return null;
  const low = Math.round(Math.min(...days.map((day) => day.low)));
  const high = Math.round(Math.max(...days.map((day) => day.high)));
  const rain = Math.round(Math.max(...days.map((day) => day.rain)));
  return {
    summary: `${place.name}, ${place.country}: ${low}–${high}°C; rain chance up to ${rain}% (${days[0].date} to ${days.at(-1).date}).`,
    source: "Open-Meteo", days,
  };
}

export function stylistApi(options = {}) {
  let root;
  let stateFile;
  let imagesDir;
  let queue = Promise.resolve();
  const running = new Set();
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const llm = () => llmSettings(setting);
  const image = () => imageSettings(setting);
  const load = () => readJson(stateFile, EMPTY);
  const library = () => readJson(path.join(root, setting("WARDROBE_DATA_DIR", "data"), "library.json"), []);
  const transact = (change) => {
    const action = queue.then(async () => {
      const state = await load();
      const result = await change(state);
      await atomicJson(stateFile, state);
      return result;
    });
    queue = action.catch(() => {});
    return action;
  };
  const setup = async () => {
    let hasReference = false;
    try { hasReference = (await stat(path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png")))).isFile(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return { hasLlm: llm().configured, hasImageKey: Boolean(image().key), hasReference };
  };

  async function generatePhoto(id) {
    try {
      const state = await load();
      const look = state.looks.find((entry) => entry.id === id);
      if (!look || look.status !== "generating") return;
      const wardrobe = await library();
      const trip = look.tripId ? state.trips.find((entry) => entry.id === look.tripId) : null;
      if (look.tripId && !trip) throw bad("This trip was deleted.");
      const eligibleIds = new Set(eligibleItems(trip, wardrobe).map((item) => item.id));
      if (look.garmentIds.some((itemId) => !eligibleIds.has(itemId))) throw bad("A look item is no longer packed. Update the trip before making its photo.");
      const garments = look.garmentIds.map((itemId) => wardrobe.find((item) => item.id === itemId));
      if (garments.some((item) => !item)) throw bad("One of the look's garments was removed.");
      const reference = path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
      const images = [{ name: "person.png", data: await readFile(reference) }];
      for (const item of garments) {
        if (!item.image?.startsWith("/api/import/library/")) throw bad(`No local image for ${item.name}.`);
        images.push({ name: `${item.part}.png`, data: await readFile(path.join(root, setting("WARDROBE_DATA_DIR", "data"), "imported", path.basename(item.image))) });
      }
      const list = garments.map((item) => `${item.part}: ${item.name} (${item.color}; ${item.tags?.join(", ") || "no tags"})`).join("\n");
      const prompt = `Create one photorealistic full-length modeled outfit photograph of the person in the FIRST reference image. Every later reference is an exact wardrobe item to put on the person. Preserve identity, face, build, skin tone, and hair. Use ALL and ONLY these selected pieces, keeping exact color, fabric, cut, pattern, logos, closures, and proportions:\n${list}\nOutfit: ${look.name}. Occasion: ${look.occasion || "everyday"}. ${look.reason}\nMake the top and bottom clearly visible. Layer garments naturally. If no shoes were selected, crop above the feet rather than inventing footwear. Do not add extra garments, accessories, people, words, or watermarks. Natural editorial photograph, anatomically plausible, plain unobtrusive background.`;
      const bytes = await requestPhoto({
        ...image(),
        model: setting("OPENAI_MODELED_MODEL", setting("OPENAI_IMAGE_MODEL", "gpt-image-2")),
        quality: setting("OPENAI_IMAGE_QUALITY", "high"), prompt, images,
      });
      const temporary = path.join(imagesDir, `${id}.tmp.png`);
      await writeFile(temporary, bytes);
      await rename(temporary, path.join(imagesDir, `${id}.png`));
      const kept = await transact((current) => {
        const target = current.looks.find((entry) => entry.id === id);
        if (!target || target.status !== "generating") return false;
        target.status = "review";
        target.image = `${BASE}/images/${id}.png?v=${Date.now()}`;
        target.error = null;
        target.updatedAt = new Date().toISOString();
        return true;
      });
      if (!kept) await rm(path.join(imagesDir, `${id}.png`), { force: true });
    } catch (error) {
      await transact((current) => {
        const target = current.looks.find((entry) => entry.id === id);
        if (target) { target.status = "failed"; target.error = error.message; target.updatedAt = new Date().toISOString(); }
      });
    } finally { running.delete(id); }
  }

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith(BASE)) return next();
    try {
      if (url.pathname === `${BASE}/state` && req.method === "GET") {
        return send(res, 200, { ...await load(), setup: await setup() });
      }
      if (url.pathname === `${BASE}/weather` && req.method === "GET") {
        const destination = field(url.searchParams.get("destination"), 100);
        if (!destination) throw bad("Enter a destination.");
        const weather = await forecastFor(destination, dateField(url.searchParams.get("startDate")), dateField(url.searchParams.get("endDate")));
        return send(res, 200, weather || { summary: "", source: "Open-Meteo", days: [], unavailable: true });
      }
      const imageMatch = url.pathname.match(/^\/api\/stylist\/images\/([a-f0-9-]{36})\.png$/);
      if (imageMatch && req.method === "GET") {
        const bytes = await readFile(path.join(imagesDir, `${imageMatch[1]}.png`));
        res.statusCode = 200;
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "no-store");
        return res.end(bytes);
      }
      if (url.pathname === `${BASE}/trips` && req.method === "POST") {
        const body = await input(req);
        const name = field(body.name, 80);
        if (!name) throw bad("Trip name is required.");
        const trip = {
          id: randomUUID(), name, destination: field(body.destination, 100),
          startDate: dateField(body.startDate), endDate: dateField(body.endDate),
          items: {}, createdAt: new Date().toISOString(),
        };
        if (trip.startDate && trip.endDate && trip.endDate < trip.startDate) throw bad("Trip end date must follow its start date.");
        await transact((state) => { state.trips.push(trip); });
        return send(res, 201, trip);
      }
      const tripMatch = url.pathname.match(/^\/api\/stylist\/trips\/([a-f0-9-]{36})$/);
      if (tripMatch && req.method === "PATCH") {
        const body = await input(req);
        const knownIds = new Set((await library()).map((item) => item.id));
        const trip = await transact((state) => {
          const current = state.trips.find((entry) => entry.id === tripMatch[1]);
          if (!current) throw bad("Trip not found.", 404);
          for (const key of ["name", "destination"]) if (key in body) current[key] = field(body[key], key === "name" ? 80 : 100);
          if (!current.name) throw bad("Trip name is required.");
          for (const key of ["startDate", "endDate"]) if (key in body) current[key] = dateField(body[key]);
          if (current.startDate && current.endDate && current.endDate < current.startDate) throw bad("Trip end date must follow its start date.");
          if (body.items && typeof body.items === "object" && !Array.isArray(body.items)) {
            current.items = Object.fromEntries(Object.entries(body.items)
              .filter(([id, status]) => knownIds.has(id) && PACK_STATES.has(status)));
          }
          return current;
        });
        return send(res, 200, trip);
      }
      if (tripMatch && req.method === "DELETE") {
        const images = await transact((state) => {
          if (!state.trips.some((entry) => entry.id === tripMatch[1])) throw bad("Trip not found.", 404);
          const removed = state.looks.filter((entry) => entry.tripId === tripMatch[1]);
          state.trips = state.trips.filter((entry) => entry.id !== tripMatch[1]);
          state.looks = state.looks.filter((entry) => entry.tripId !== tripMatch[1]);
          return removed.map((entry) => entry.id);
        });
        await Promise.all(images.map((id) => rm(path.join(imagesDir, `${id}.png`), { force: true })));
        return send(res, 200, { deleted: true });
      }
      if (url.pathname === `${BASE}/suggest` && req.method === "POST") {
        const body = await input(req);
        const count = Number(body.count);
        if (!Number.isInteger(count) || count < 1 || count > 6) throw bad("Choose 1 to 6 looks.");
        if (!llm().configured) throw bad("Configure WARDROBE_LLM_API_KEY or WARDROBE_LLM_BASE_URL in .env and restart the app.", 422);
        const state = await load();
        const trip = body.tripId ? state.trips.find((entry) => entry.id === body.tripId) : null;
        if (body.tripId && !trip) throw bad("Trip not found.", 404);
        const tripAvailable = eligibleItems(trip, await library());
        const selectedIds = Array.isArray(body.selectedItemIds) ? body.selectedItemIds : tripAvailable.map((item) => item.id);
        const tripAvailableIds = new Set(tripAvailable.map((item) => item.id));
        if (selectedIds.some((id) => !tripAvailableIds.has(id)) || new Set(selectedIds).size !== selectedIds.length) throw bad("Choose items from the available wardrobe only.");
        const selectedSet = new Set(selectedIds);
        const available = tripAvailable.filter((item) => selectedSet.has(item.id));
        if (!available.some((item) => item.part === "upperbody") || !available.some((item) => item.part === "lowerbody")) {
          throw bad("Pack at least one top and one bottom before requesting looks.");
        }
        const anchorId = field(body.anchorId, 80);
        if (anchorId && !available.some((item) => item.id === anchorId)) throw bad("Anchor piece is not available.");
        const palettes = relevantPalettes(available, 10, anchorId);
        const conditions = field(body.conditions, 300);
        let weather = conditions ? { summary: conditions, source: "manual" } : null;
        if (!weather && trip?.destination) {
          try { weather = await forecastFor(trip.destination, trip.startDate, trip.endDate); }
          catch { weather = null; }
        }
        const occasion = field(body.occasion, 100);
        const brief = field(body.brief, 600);
        const itemsText = available.map((item) => `${item.id} | ${item.part} | ${item.name} | ${item.color} | ${item.secondaryColor || ""} | ${item.tags?.join(", ") || ""}${trip?.items[item.id] === "worn" ? " | WORN/LAUNDRY: warn if used" : ""}`).join("\n");
        const palettesText = palettes.map((palette) => `#${palette.id}: ${palette.colors.map((color) => `${color.name} ${color.hex}`).join(", ")}`).join("\n");
        const prompt = `You are a practical personal stylist. Propose exactly ${count} distinct outfits using ONLY the item IDs listed below. Every look needs exactly one upperbody and one lowerbody item, with at most one wholebody_up, two accessories_up, and one shoes item. Include the anchor item ${anchorId || "(none specified)"} in every look if one is specified. Keep outfits wearable for the occasion, weather, and actual garment tags. Vary garments across looks. Use Sanzo Wada's color combinations as inspiration, not a rigid match; black, white, cream, grey, and brown may serve as neutrals. Pick paletteId from the reference combinations below. Explain the color and practical clothing fit briefly. Do not invent garments.\n\nOccasion: ${occasion || "everyday"}\nConditions: ${weather?.summary || "not supplied; do not assume a forecast"}\nUser request: ${brief || "comfortable, considered outfits"}\n\nAvailable items:\n${itemsText}\n\nRelevant Wada palettes:\n${palettesText}`;
        let raw;
        let ideas;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          raw = await requestLooks({
            ...llm(),
            model: setting("WARDROBE_STYLIST_MODEL", setting("WARDROBE_LLM_MODEL", setting("OPENAI_STYLIST_MODEL", "gpt-5.4-mini"))),
            prompt: attempt ? `${prompt}\nYour previous answer had invalid or repeated item combinations. Follow all constraints exactly.` : prompt,
            count,
          });
          try {
            ideas = raw.map((entry) => validateLook(entry, available, palettes));
            if (anchorId && ideas.some((entry) => !entry.garmentIds.includes(anchorId))) throw new Error("Anchor item missing.");
            const signatures = ideas.map((entry) => [...entry.garmentIds].sort().join("|"));
            if (new Set(signatures).size !== signatures.length) throw new Error("Repeated garment combination.");
            break;
          } catch (error) {
            if (attempt) throw bad(`The LLM did not return usable looks: ${error.message}`, 502);
          }
        }
        const now = new Date().toISOString();
        const looks = ideas.map((idea) => ({
          ...idea, id: randomUUID(), tripId: trip?.id || null, anchorId: anchorId || null,
          selectionIds: selectedIds, status: "idea",
          warnings: warningsFor(idea, trip), weather: weather?.summary || "",
          weatherSource: weather?.source || null, image: null, error: null,
          messages: [], date: "", savedAt: null, createdAt: now, updatedAt: now,
        }));
        await transact(async (current) => {
          const currentTrip = trip ? current.trips.find((entry) => entry.id === trip.id) : null;
          if (trip && !currentTrip) throw bad("Trip was deleted.", 409);
          const currentIds = new Set(eligibleItems(currentTrip, await library()).map((item) => item.id));
          if (looks.some((look) => look.garmentIds.some((id) => !currentIds.has(id)))) throw bad("Available items changed while the stylist was working. Ask again.", 409);
          for (const look of looks) look.warnings = warningsFor(look, currentTrip);
          current.looks.push(...looks);
        });
        return send(res, 201, looks);
      }
      const lookMatch = url.pathname.match(/^\/api\/stylist\/looks\/([a-f0-9-]{36})(?:\/(revise|photo|save))?$/);
      if (lookMatch && req.method === "POST" && lookMatch[2] === "revise") {
        const body = await input(req);
        const message = field(body.message, 600);
        if (!message) throw bad("Enter a revision request.");
        if (!llm().configured) throw bad("Configure WARDROBE_LLM_API_KEY or WARDROBE_LLM_BASE_URL in .env and restart the app.", 422);
        const state = await load();
        const current = state.looks.find((entry) => entry.id === lookMatch[1]);
        if (!current) throw bad("Look not found.", 404);
        if (!["idea", "failed"].includes(current.status)) throw bad("Revise a draft before generating its photo.", 409);
        const trip = current.tripId ? state.trips.find((entry) => entry.id === current.tripId) : null;
        if (current.tripId && !trip) throw bad("Trip not found.", 404);
        const selectedSet = new Set(current.selectionIds || []);
        const available = eligibleItems(trip, await library()).filter((item) => selectedSet.has(item.id));
        const palettes = relevantPalettes(available, 10, current.anchorId);
        const prompt = `Revise this single outfit according to the user's request. Use ONLY these wardrobe item IDs. Return exactly one complete look with one upperbody and one lowerbody item, plus at most one layer, two accessories, and shoes. ${current.anchorId ? `Keep anchor item ${current.anchorId} in the look.` : ""} Use Wada palettes for inspiration, with neutrals allowed. Keep the user's intended occasion and weather in mind.\nCurrent look: ${JSON.stringify({ name: current.name, reason: current.reason, garmentIds: current.garmentIds, occasion: current.occasion })}\nConversation: ${JSON.stringify(current.messages.slice(-8))}\nLatest request: ${message}\nWeather: ${current.weather || "not supplied"}\nItems: ${JSON.stringify(available.map(({ id, name, part, color, tags }) => ({ id, name, part, color, tags })))}\nWada palettes: ${JSON.stringify(palettes)}`;
        const response = await requestLooks({
          ...llm(),
          model: setting("WARDROBE_STYLIST_MODEL", setting("WARDROBE_LLM_MODEL", setting("OPENAI_STYLIST_MODEL", "gpt-5.4-mini"))), prompt, count: 1,
        });
        let idea;
        try {
          idea = validateLook(response[0], available, palettes);
          if (current.anchorId && !idea.garmentIds.includes(current.anchorId)) throw new Error("Anchor item missing.");
        }
        catch (error) { throw bad(`The LLM returned an invalid revision: ${error.message}`, 502); }
        const updated = await transact(async (latest) => {
          const target = latest.looks.find((entry) => entry.id === lookMatch[1]);
          if (!target || !["idea", "failed"].includes(target.status)) throw bad("Draft changed while revising.", 409);
          const latestTrip = target.tripId ? latest.trips.find((entry) => entry.id === target.tripId) : null;
          const currentIds = new Set(eligibleItems(latestTrip, await library()).map((item) => item.id));
          if (idea.garmentIds.some((id) => !currentIds.has(id))) throw bad("Available items changed while the stylist was working. Revise again.", 409);
          Object.assign(target, idea, {
            status: "idea", warnings: warningsFor(idea, latestTrip), error: null, image: null,
            messages: [...target.messages, { role: "user", text: message }, { role: "assistant", text: idea.reason }],
            updatedAt: new Date().toISOString(),
          });
          return target;
        });
        await rm(path.join(imagesDir, `${lookMatch[1]}.png`), { force: true });
        return send(res, 200, updated);
      }
      if (lookMatch && req.method === "POST" && lookMatch[2] === "photo") {
        const config = await setup();
        if (!config.hasImageKey || !config.hasReference) throw bad("Add OPENAI_IMAGE_API_KEY and data/model-reference.png before making a photo.", 422);
        const currentState = await load();
        const currentLook = currentState.looks.find((entry) => entry.id === lookMatch[1]);
        if (!currentLook) throw bad("Look not found.", 404);
        const currentTrip = currentLook.tripId ? currentState.trips.find((entry) => entry.id === currentLook.tripId) : null;
        if (currentLook.tripId && !currentTrip) throw bad("Trip not found.", 404);
        const eligibleIds = new Set(eligibleItems(currentTrip, await library()).map((item) => item.id));
        if (currentLook.garmentIds.some((id) => !eligibleIds.has(id))) throw bad("A look item is no longer packed. Update the trip before making its photo.", 409);
        const look = await transact((state) => {
          const current = state.looks.find((entry) => entry.id === lookMatch[1]);
          if (!current) throw bad("Look not found.", 404);
          if (!["idea", "failed", "review"].includes(current.status)) throw bad("This look cannot start a photo now.", 409);
          current.status = "generating";
          current.error = null;
          current.updatedAt = new Date().toISOString();
          return current;
        });
        if (!running.has(look.id)) { running.add(look.id); void generatePhoto(look.id); }
        return send(res, 202, look);
      }
      if (lookMatch && req.method === "POST" && lookMatch[2] === "save") {
        const snapshot = await load();
        const saving = snapshot.looks.find((entry) => entry.id === lookMatch[1]);
        if (!saving) throw bad("Look not found.", 404);
        const savingTrip = saving.tripId ? snapshot.trips.find((entry) => entry.id === saving.tripId) : null;
        if (saving.tripId && !savingTrip) throw bad("Trip not found.", 404);
        const eligibleIds = new Set(eligibleItems(savingTrip, await library()).map((item) => item.id));
        if (saving.garmentIds.some((id) => !eligibleIds.has(id))) throw bad("A look item is no longer packed. Update the trip before saving.", 409);
        const look = await transact((state) => {
          const current = state.looks.find((entry) => entry.id === lookMatch[1]);
          if (!current) throw bad("Look not found.", 404);
          if (current.status === "generating") throw bad("Wait for the photo to finish before saving.", 409);
          current.savedAt = current.savedAt || new Date().toISOString();
          current.updatedAt = new Date().toISOString();
          return current;
        });
        return send(res, 200, look);
      }
      if (lookMatch && req.method === "PATCH" && !lookMatch[2]) {
        const body = await input(req);
        const look = await transact((state) => {
          const current = state.looks.find((entry) => entry.id === lookMatch[1]);
          if (!current) throw bad("Look not found.", 404);
          if ("name" in body) current.name = field(body.name, 80) || current.name;
          if ("date" in body) {
            if (!current.savedAt) throw bad("Save the outfit before assigning a day.", 409);
            const trip = state.trips.find((entry) => entry.id === current.tripId);
            const date = dateField(body.date);
            if (date && (!trip || (trip.startDate && date < trip.startDate) || (trip.endDate && date > trip.endDate))) throw bad("Choose a date within this trip.");
            current.date = date;
          }
          current.updatedAt = new Date().toISOString();
          return current;
        });
        return send(res, 200, look);
      }
      if (lookMatch && req.method === "DELETE" && !lookMatch[2]) {
        await transact((state) => {
          if (!state.looks.some((entry) => entry.id === lookMatch[1])) throw bad("Look not found.", 404);
          state.looks = state.looks.filter((entry) => entry.id !== lookMatch[1]);
        });
        await rm(path.join(imagesDir, `${lookMatch[1]}.png`), { force: true });
        return send(res, 200, { deleted: true });
      }
      throw bad("Stylist route not found.", 404);
    } catch (error) {
      return send(res, error.status || 500, { error: error.status ? error.message : "Internal stylist error." });
    }
  }

  return {
    name: "wardrobe-stylist-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      const dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
      stateFile = path.join(dataDir, "stylist.json");
      imagesDir = path.join(dataDir, "outfit-images");
      await mkdir(imagesDir, { recursive: true });
      const state = await load();
      let changed = false;
      for (const look of state.looks) if (look.status === "generating") {
        look.status = "failed";
        look.error = "Generation stopped when the server restarted. Retry the photo.";
        changed = true;
      }
      if (changed) await atomicJson(stateFile, state);
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { deriveFeedback, today } from "./feedback.mjs";
import { describeItem, normalizeAttributes } from "./garment-attributes.mjs";
import { assignHandles, buildShortlist, candidateLine, describePlan, enumerateLooks, partLabel, scoreLook, singleChanges, unsupportedColors, validatePicks, validatePlan } from "./outfit-engine.mjs";
import { eligibleItems, PACK_STATES, relevantPalettes, validateLook, warningsFor } from "./stylist-core.mjs";
import { chatJson, imageSettings, llmSettings } from "./llm-client.mjs";
import { attributeOptions, DEFAULT_OCCASIONS, historyOccasions, normalizeCandidates, rankPurchases, wardrobeCoverage } from "./buy-next.mjs";
import { readProfile } from "./profile-api.mjs";
import { profileScore, profileSummary } from "./profile.mjs";

const BASE = "/api/stylist";
const EMPTY = { version: 1, trips: [], looks: [], wears: [], swaps: [] };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_OBJECT = '{"formality":[lowest,highest],"shoeFormality":[lowest,highest],"maxWarmth":<0-4 or null>,"outerLayer":"needed|optional|skip","layerMaxWarmth":<0-4 or null>,"include":["handle"],"exclude":["handle"]}';
const PLAN_SHAPE = `{"plan":${PLAN_OBJECT}}`;
const REVISE_SHAPE = '{"change":"V1" or null,"pieces":["T1","B1"] or null,"name":"...","reason":"..."}';
const PLAN_FIELDS = `- formality: [lowest, highest] on the 1-5 scale (1 athletic, 2 casual, 3 smart casual, 4 dressy or business, 5 formal): the range the occasion calls for, widened only when the user asks for deliberate high-low dressing.
- shoeFormality: [lowest, highest] for shoes, which can sit apart from the clothes; for example, athletic sneakers (1) suit a day of walking even with casual clothes.
- maxWarmth: the warmest top, bottoms, or shoes the conditions allow, on the 0-4 scale (0 hot weather only, 1 light, 2 medium, 3 warm, 4 cold-weather outerwear), or null when the weather sets no limit.
- outerLayer: "needed", "optional", or "skip". When the day swings between cool and warm, dress the base for the warm part and plan a removable layer for the cool part.
- layerMaxWarmth: the warmest outer layer that suits the conditions, 0-4, or null.
- include: handles of pieces the user explicitly asks to wear, otherwise an empty list.
- exclude: handles of pieces the user explicitly rules out, otherwise an empty list.`;
const PLAN_GUIDANCE = `Set one plan for this request from the occasion, the conditions, and the user's request.\n${PLAN_FIELDS}`;
const STYLING_GUIDANCE = "Each item lists its colors (lightness, temperature, and whether each is a base neutral, earth neutral, or accent), formality from 1 (athletic) to 5 (formal), warmth from 0 (hot weather) to 4 (cold weather), and its fabric, pattern, and fit when known. Build from the bottoms and top first. Let base and earth neutrals carry most of the outfit and use at most two accent colors. When pieces share a color family, step the lightness clearly or vary the texture so they do not read as a near miss. Wear at most one statement piece and at most two patterns, at different scales. Tuck shirts that have tails. Add a bag or watch only when it serves the occasion or was requested; accessories do not define the clothing colors. If the wardrobe lacks a piece the occasion needs, leave that slot out and say what is missing in the reason. Use Wada combinations only as loose color inspiration. In the reason, describe the actual garment colors and why the pieces work together; do not cite palette numbers or claim colors the outfit does not contain.";

function planLine(item, handleOf) {
  const { formality, warmth } = normalizeAttributes(item.attributes, item.part);
  return `${handleOf.get(item.id)} | ${partLabel(item.part)} | ${item.name} | formality ${formality ?? "unknown"}, warmth ${warmth ?? "unknown"}`;
}

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

async function askModel({ key, baseUrl, model, prompt, shape, onProgress, signal, reasoningEffort }) {
  try {
    return await chatJson({ key, baseUrl, model, prompt: `${prompt}\nReturn JSON in this exact shape: ${shape}.`, timeout: 300000, onProgress, signal, reasoningEffort });
  } catch (error) {
    if (error.name === "TimeoutError") throw bad("The LLM took more than five minutes. Try fewer looks or a smaller item selection.", 504);
    throw bad(`The LLM could not suggest outfits: ${error.message}`, 502);
  }
}

// Asks once, and once more with the reason when the answer fails its check. The check learns which attempt it is,
// so soft checks can ask for one correction and then accept.
async function askUntilValid({ check, failure, onRetry, prompt, ...request }) {
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await askModel({ ...request, prompt: feedback ? `${prompt}\nYour previous answer was rejected: ${feedback} Answer again.` : prompt });
    try { return check(raw, attempt); }
    catch (error) {
      if (attempt) throw bad(`${failure}: ${error.message}`, 502);
      feedback = error.message;
      onRetry?.();
    }
  }
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
  const library = () => readJson(path.join(path.resolve(root, setting("WARDROBE_DATA_DIR", "data")), "library.json"), []);
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
        images.push({ name: `${item.part}.png`, data: await readFile(path.join(path.resolve(root, setting("WARDROBE_DATA_DIR", "data")), "imported", path.basename(new URL(item.image, "http://localhost").pathname))) });
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
        return send(res, 200, { wears: [], swaps: [], ...await load(), setup: await setup() });
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
        const streaming = req.headers?.accept?.includes("application/x-ndjson");
        const emit = (stage) => {
          if (!streaming) return;
          if (!res.headersSent) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            res.flushHeaders?.();
          }
          res.write(`${JSON.stringify({ type: "progress", stage })}\n`);
        };
        const disconnected = new AbortController();
        res.on?.("close", () => { if (!res.writableEnded) disconnected.abort(); });
        const body = await input(req);
        const count = Number(body.count);
        if (!Number.isInteger(count) || count < 1 || count > 6) throw bad("Choose 1 to 6 looks.");
        if (!llm().configured) throw bad("Configure WARDROBE_LLM_API_KEY or WARDROBE_LLM_BASE_URL in .env and restart the app.", 422);
        emit("preparing");
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
          emit("weather");
          try { weather = await forecastFor(trip.destination, trip.startDate, trip.endDate); }
          catch { weather = null; }
        }
        const occasion = field(body.occasion, 100);
        const brief = field(body.brief, 600);
        const model = setting("WARDROBE_STYLIST_MODEL", setting("WARDROBE_LLM_MODEL", setting("OPENAI_STYLIST_MODEL", "gpt-5.4-mini")));
        const signal = AbortSignal.any([AbortSignal.timeout(300000), disconnected.signal]);
        const { handleOf, itemOf, sorted } = assignHandles(available);
        const wornNote = (item) => trip?.items[item.id] === "worn" ? " | worn on this trip; use only if needed" : "";
        const conditionsText = weather?.days?.length
          ? `${weather.summary}\n${weather.days.map((day) => `${day.date}: ${Math.round(day.low)}-${Math.round(day.high)}°C, rain chance ${day.rain}%`).join("\n")}`
          : weather?.summary || "not supplied; do not assume a forecast";
        const profile = await readProfile(path.resolve(root, setting("WARDROBE_DATA_DIR", "data")));
        const wearer = profileSummary(profile);
        const context = `Occasion: ${occasion || "everyday"}\nConditions: ${conditionsText}\nUser request: ${brief || "comfortable, considered outfits"}${wearer ? `\n${wearer}` : ""}`;

        emit("plan");
        const planLines = sorted.map((item) => planLine(item, handleOf));
        const plan = await askUntilValid({
          ...llm(), model, signal, shape: PLAN_SHAPE, failure: "The LLM did not return a usable plan", onRetry: () => emit("retrying"),
          prompt: `You are a practical personal stylist planning outfits. ${PLAN_GUIDANCE}\n\n${context}\n\nItems:\n${planLines.join("\n")}`,
          check: (raw) => validatePlan(raw.plan, itemOf),
        });

        emit("candidates");
        const feedback = deriveFeedback(state, await library());
        const { looks: pool, gaps, mentioned } = enumerateLooks(available, plan, { anchorId, rejectedSets: feedback.rejectedSets, rejectedPairs: feedback.rejectedPairs });
        if (!pool.length) throw bad(`No combination in this selection fits the request. ${gaps.join(" ")}`.trim(), 422);
        const shortlist = buildShortlist(pool.map((look) => {
          const history = scoreLook(look, feedback);
          const personal = profileScore(look, profile);
          return { ...look, score: history.score + personal.score, notes: [...history.notes, ...personal.notes] };
        }));
        const want = Math.min(count, shortlist.length);
        const accessories = new Map(sorted.filter((item) => item.part === "accessories_up").map((item) => [handleOf.get(item.id), item]));
        const required = [anchorId, ...plan.include].map((id) => available.find((item) => item.id === id)).filter((item) => item?.part === "accessories_up");
        const used = new Set(shortlist.flatMap((look) => look.ids));
        const legend = sorted.filter((item) => used.has(item.id)).map((item) => `${describeItem(item, handleOf.get(item.id))}${wornNote(item)}`);
        const accessoryLegend = [...accessories.values()].map((item) => `${describeItem(item, handleOf.get(item.id))}${wornNote(item)}`);
        const palettesText = palettes.map((palette) => `#${palette.id}: ${palette.colors.map((color) => `${color.name} ${color.hex}`).join(", ")}`).join("\n");
        const pickPrompt = `You are a practical personal stylist. Choose exactly ${want} looks for this request from the candidates below. Every candidate already fits the plan, the weather, and the selected wardrobe, so judge which combine best for the occasion and the user's request: color, texture, proportion, and variety. Choose looks that differ in top or bottom whenever the candidates allow. Each reason is shown on its own card, so describe only that look's pieces and do not compare it with the other picks. Notes after a candidate come from the user's own history. You may add up to two accessories (A handles) to a look when they serve the occasion or the request${required.length ? `; every look must include ${required.map((item) => handleOf.get(item.id)).join(" and ")}` : ""}. ${gaps.length ? "Mention the relevant gap briefly in the reason. " : ""}${STYLING_GUIDANCE}\n\n${context}\nPlan: ${describePlan(plan)}.${gaps.length ? `\nGaps: ${gaps.join(" ")}` : ""}\n\nPieces:\n${legend.join("\n")}\n\nAccessories:\n${accessoryLegend.join("\n") || "none"}\n\nCandidates:\n${shortlist.map((look) => candidateLine(look, handleOf)).join("\n")}\n\nRelevant Wada palettes:\n${palettesText}`;

        emit("model");
        const picks = await askUntilValid({
          ...llm(), model, signal, onProgress: streaming ? emit : undefined, onRetry: () => emit("retrying"),
          shape: `{"picks":[{"look":"L1","accessories":["A1"],"name":"...","reason":"..."}]} with exactly ${want} picks`,
          failure: "The LLM did not return usable looks", prompt: pickPrompt,
          check: (raw, attempt) => { emit("checking"); return validatePicks(raw, shortlist, accessories, want, { required, mentioned, checkReasons: attempt === 0 }); },
        });
        const ideas = picks.map((pick) => validateLook({ name: pick.name, reason: pick.reason, occasion: occasion || "everyday", garmentIds: pick.garmentIds }, available));
        const now = new Date().toISOString();
        const looks = ideas.map((idea) => ({
          ...idea, plan, gaps, id: randomUUID(), tripId: trip?.id || null, anchorId: anchorId || null, verdict: null,
          selectionIds: selectedIds, status: "idea",
          warnings: warningsFor(idea, trip), weather: weather?.summary || "",
          weatherSource: weather?.source || null, image: null, error: null,
          messages: [], date: "", savedAt: null, createdAt: now, updatedAt: now,
        }));
        emit("saving");
        await transact(async (current) => {
          const currentTrip = trip ? current.trips.find((entry) => entry.id === trip.id) : null;
          if (trip && !currentTrip) throw bad("Trip was deleted.", 409);
          const currentIds = new Set(eligibleItems(currentTrip, await library()).map((item) => item.id));
          if (looks.some((look) => look.garmentIds.some((id) => !currentIds.has(id)))) throw bad("Available items changed while the stylist was working. Ask again.", 409);
          for (const look of looks) look.warnings = warningsFor(look, currentTrip);
          current.looks.push(...looks);
        });
        if (streaming) {
          res.write(`${JSON.stringify({ type: "done", looks })}\n`);
          return res.end();
        }
        return send(res, 201, looks);
      }
      if (url.pathname === `${BASE}/buy-next` && req.method === "GET") {
        const state = await load();
        const history = historyOccasions(state.looks);
        return send(res, 200, { occasions: history.size ? [...history.keys()].slice(0, 6) : DEFAULT_OCCASIONS, last: state.buyNext || null });
      }
      if (url.pathname === `${BASE}/buy-next` && req.method === "POST") {
        const body = await input(req);
        const names = [...new Set((Array.isArray(body.occasions) ? body.occasions : []).map((name) => field(name, 60).toLowerCase()).filter(Boolean))];
        if (!names.length || names.length > 8) throw bad("Name 1 to 8 occasions.");
        if (!llm().configured) throw bad("Configure WARDROBE_LLM_API_KEY or WARDROBE_LLM_BASE_URL in .env and restart the app.", 422);
        const items = await library();
        if (!items.some((item) => item.part === "upperbody") || !items.some((item) => item.part === "lowerbody")) throw bad("Import at least one top and one bottom first.");
        const history = historyOccasions((await load()).looks);
        const profile = await readProfile(path.resolve(root, setting("WARDROBE_DATA_DIR", "data")));
        const wearer = profileSummary(profile);
        const model = setting("WARDROBE_STYLIST_MODEL", setting("WARDROBE_LLM_MODEL", setting("OPENAI_STYLIST_MODEL", "gpt-5.4-mini")));
        const { handleOf, itemOf, sorted } = assignHandles(items);
        const plans = await askUntilValid({
          ...llm(), model, failure: "The LLM did not return usable plans",
          shape: `{"plans":[{"occasion":"...","plan":${PLAN_OBJECT}}]} with one entry per occasion, in the order listed`,
          prompt: `You are a practical personal stylist reviewing a wardrobe. For each occasion below, set the plan you would use when dressing for it, assuming typical weather unless the occasion names the conditions. Each plan has these fields:\n${PLAN_FIELDS}${wearer ? `\n${wearer}` : ""}\n\nOccasions:\n${names.map((name, index) => `${index + 1}. ${name}`).join("\n")}\n\nItems:\n${sorted.map((item) => planLine(item, handleOf)).join("\n")}`,
          check: (raw) => {
            if (!Array.isArray(raw.plans) || raw.plans.length !== names.length) throw new Error(`Return exactly ${names.length} entries in "plans", one per occasion in the order listed.`);
            return raw.plans.map((entry) => validatePlan(entry?.plan, itemOf));
          },
        });
        const occasions = names.map((name, index) => ({ name, weight: history.get(name) || 1, plan: plans[index] }));
        const coverage = wardrobeCoverage(items, occasions, profile);
        const candidates = await askUntilValid({
          ...llm(), model, failure: "The LLM did not suggest usable pieces",
          shape: '{"candidates":[{"name":"...","part":"upperbody|lowerbody|wholebody_up|shoes","color":"#rrggbb","attributes":{"category":"...","formality":<1-5>,"warmth":<0-4>},"why":"..."}]}',
          prompt: `You are a practical personal stylist reviewing this wardrobe for its next purchase. Propose 8 different pieces the wearer could buy that would add the most new complete outfits across the occasions below. A complete outfit is a top and bottoms worn with shoes, plus an outer layer when the occasion needs one, all fitting that occasion's plan. Favor pieces that close the listed gaps and combine with many existing pieces, and avoid near-duplicates of what the wardrobe already has. Propose only tops, bottoms, outer layers, or shoes: specific, widely available pieces, each in one main color.${wearer ? ` ${wearer}` : ""}\n\nOccasions:\n${coverage.map((entry, index) => `- ${entry.occasion}: plan ${describePlan(occasions[index].plan)}; complete outfits now: ${entry.outfits}${entry.gaps.length ? `; gaps: ${entry.gaps.join(" ")}` : ""}`).join("\n")}\n\nWardrobe:\n${sorted.map((item) => describeItem(item, handleOf.get(item.id))).join("\n")}\n\nGive each piece its attributes with these keys and options; formality runs from 1 (athletic) to 5 (formal) and warmth from 0 (hot weather) to 4 (cold weather):\n${attributeOptions()}\nIn "why", say in one sentence which occasions and existing pieces it works with.`,
          check: (raw) => {
            const list = normalizeCandidates(raw);
            if (!list.length) throw new Error('Return "candidates" with a part, a #rrggbb color, and at least formality and warmth in "attributes" for each.');
            return list;
          },
        });
        // The model refers to pieces by handle; the page shows their names instead.
        for (const candidate of candidates) candidate.why = candidate.why.replace(/\b[TBOSA]\d+\b/g, (handle) => itemOf.get(handle)?.name || handle);
        const record = { at: new Date().toISOString(), occasions: occasions.map(({ name, weight, plan }) => ({ name, weight, plan })), ...rankPurchases(items, occasions, candidates, profile) };
        await transact((state) => { state.buyNext = record; });
        return send(res, 200, record);
      }
      const wearMatch = url.pathname.match(/^\/api\/stylist\/wears\/([a-f0-9-]{36})$/);
      if (wearMatch && req.method === "DELETE") {
        await transact((state) => {
          if (!(state.wears || []).some((entry) => entry.id === wearMatch[1])) throw bad("Wear not found.", 404);
          state.wears = state.wears.filter((entry) => entry.id !== wearMatch[1]);
        });
        return send(res, 200, { deleted: true });
      }
      const lookMatch = url.pathname.match(/^\/api\/stylist\/looks\/([a-f0-9-]{36})(?:\/(revise|photo|save|verdict|wear))?$/);
      if (lookMatch && req.method === "POST" && lookMatch[2] === "verdict") {
        const body = await input(req);
        if (![null, "up", "down"].includes(body.verdict ?? null)) throw bad('Set the verdict to "up", "down", or null.');
        const look = await transact((state) => {
          const current = state.looks.find((entry) => entry.id === lookMatch[1]);
          if (!current) throw bad("Look not found.", 404);
          current.verdict = body.verdict ?? null;
          current.verdictAt = current.verdict ? new Date().toISOString() : null;
          current.updatedAt = new Date().toISOString();
          return current;
        });
        return send(res, 200, look);
      }
      if (lookMatch && req.method === "POST" && lookMatch[2] === "wear") {
        const body = await input(req);
        const known = new Set((await library()).map((item) => item.id));
        const wear = await transact((state) => {
          const current = state.looks.find((entry) => entry.id === lookMatch[1]);
          if (!current) throw bad("Look not found.", 404);
          const garmentIds = [...new Set(Array.isArray(body.garmentIds) ? body.garmentIds : current.garmentIds)].filter((id) => known.has(id));
          if (!garmentIds.length) throw bad("Choose at least one worn item.");
          const entry = { id: randomUUID(), lookId: current.id, date: dateField(body.date) || today(), garmentIds, at: new Date().toISOString() };
          state.wears = [...(state.wears || []), entry];
          return entry;
        });
        return send(res, 201, wear);
      }
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
        const { handleOf, itemOf, sorted } = assignHandles(available);
        const wearer = profileSummary(await readProfile(path.resolve(root, setting("WARDROBE_DATA_DIR", "data"))));
        const options = singleChanges(current.garmentIds, available, handleOf, { anchorId: current.anchorId });
        const prompt = `Revise this look for the user's latest request. Prefer the smallest change that answers it: when one of the single changes below does, return its label as "change" and set "pieces" to null. Only when the request needs more than one change, set "change" to null and give the complete look as "pieces": one top and one bottom, plus at most one outer layer, one pair of shoes, and two accessories. ${current.anchorId ? `Keep ${handleOf.get(current.anchorId)} in the look. ` : ""}${STYLING_GUIDANCE}\nCurrent look: ${current.garmentIds.map((id) => handleOf.get(id)).filter(Boolean).join(" + ")}; ${current.name}: ${current.reason}\nConversation: ${JSON.stringify(current.messages.slice(-8))}\nLatest request: ${message}\nOccasion: ${current.occasion || "everyday"}\nWeather: ${current.weather || "not supplied"}${wearer ? `\n${wearer}` : ""}\n\nPieces:\n${sorted.map((item) => describeItem(item, handleOf.get(item.id))).join("\n")}\n\nSingle changes:\n${options.map((option) => `${option.label}: ${option.text}`).join("\n") || "none"}`;
        const idea = await askUntilValid({
          ...llm(), model: setting("WARDROBE_STYLIST_MODEL", setting("WARDROBE_LLM_MODEL", setting("OPENAI_STYLIST_MODEL", "gpt-5.4-mini"))),
          prompt, shape: REVISE_SHAPE, failure: "The LLM returned an invalid revision",
          check: (raw, attempt) => {
            let ids;
            if (raw.change) {
              const option = options.find((entry) => entry.label === raw.change);
              if (!option) throw new Error(`"${raw.change}" is not one of the listed changes.`);
              ids = option.ids;
            } else {
              if (!Array.isArray(raw.pieces)) throw new Error('Give either "change" or "pieces".');
              const unknown = raw.pieces.filter((handle) => !itemOf.has(handle));
              if (unknown.length) throw new Error(`Use listed handles only; ${unknown.join(", ")} is not listed.`);
              ids = raw.pieces.map((handle) => itemOf.get(handle).id);
            }
            const look = validateLook({ name: raw.name, reason: raw.reason, occasion: current.occasion, garmentIds: ids }, available);
            if (current.anchorId && !look.garmentIds.includes(current.anchorId)) throw new Error("Keep the anchor piece in the look.");
            const pieces = [...new Set([...look.garmentIds, ...current.garmentIds])].map((id) => available.find((item) => item.id === id)).filter(Boolean);
            const claimed = unsupportedColors(look.reason, pieces);
            if (attempt === 0 && claimed.length) throw new Error(`Describe only colors the pieces have; the reason mentions ${claimed.join(" and ")}, which ${claimed.length === 1 ? "is" : "are"} not in the look.`);
            return look;
          },
        });
        const updated = await transact(async (latest) => {
          const target = latest.looks.find((entry) => entry.id === lookMatch[1]);
          if (!target || !["idea", "failed"].includes(target.status)) throw bad("Draft changed while revising.", 409);
          const latestTrip = target.tripId ? latest.trips.find((entry) => entry.id === target.tripId) : null;
          const currentIds = new Set(eligibleItems(latestTrip, await library()).map((item) => item.id));
          if (idea.garmentIds.some((id) => !currentIds.has(id))) throw bad("Available items changed while the stylist was working. Revise again.", 409);
          const removed = target.garmentIds.filter((id) => !idea.garmentIds.includes(id));
          const added = idea.garmentIds.filter((id) => !target.garmentIds.includes(id));
          if (removed.length === 1 && added.length === 1) {
            latest.swaps = [...(latest.swaps || []), { lookId: target.id, out: removed[0], in: added[0], rest: idea.garmentIds.filter((id) => id !== added[0]), at: new Date().toISOString() }];
          }
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
      if (url.pathname === `${BASE}/suggest` && res.headersSent && req.headers?.accept?.includes("application/x-ndjson")) {
        if (!res.destroyed) res.write(`${JSON.stringify({ type: "error", message: error.status ? error.message : "Internal stylist error." })}\n`);
        return res.end();
      }
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

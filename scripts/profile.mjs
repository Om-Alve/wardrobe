// The wearer's profile: coloring read from their photo and confirmed by them, plus stated preferences.
// It only nudges scores and adds context for the model; it never filters looks.
// Shared by the server and the profile page, so this module must stay free of Node imports.
import { colorProfile } from "./garment-attributes.mjs";

// Published Monk Skin Tone scale (Google and Ellis Monk), 1 lightest to 10 deepest.
export const MONK_SCALE = ["#f6ede4", "#f3e7db", "#f7ead0", "#eadaba", "#d7bd96", "#a07e56", "#825c43", "#604134", "#3a312a", "#292420"];
export const CHOICES = {
  hairLightness: ["light", "medium", "dark"],
  contrast: ["low", "medium", "high"],
  undertone: ["warm", "cool", "neutral", "olive", "unknown"],
  undertoneConfidence: ["low", "medium", "high"],
  fit: ["slim", "regular", "relaxed"],
};
export const PHOTO_FIELDS = ["hairLightness", "contrast", "skinDepth", "undertone", "undertoneConfidence", "greyHair"];
const READ_FROM_PHOTO = ["hairLightness", "contrast", "skinDepth", "undertone", "greyHair"];
const FIELD_NAMES = { hairLightness: "hair lightness", contrast: "contrast", skinDepth: "skin depth", undertone: "undertone", greyHair: "grey hair" };
const FRAMING = { "full-body": "Full-body photo", "waist-up": "Waist-up photo", face: "Face photo" };
const LIGHTING = ["neutral", "warm", "cool", "mixed"];
// Personal contrast bands in CIELAB lightness, overlapping because the categories are fuzzy.
const CONTRAST_BANDS = { low: [0, 25], medium: [20, 50], high: [45, 100] };
const NEAR_FACE = new Set(["upperbody", "wholebody_up"]);
const WORN = new Set(["upperbody", "lowerbody", "wholebody_up", "shoes"]);
// Measurements typed into free text are dropped, like weight and body keys.
const MEASUREMENT = /\b\d+(?:[.,]\d+)?\s*(?:cm|mm|m|in|inch|inches|ft|feet|foot|kg|kgs|lb|lbs|pounds?|stone)\b|\b\d\s*'\s*\d{1,2}\b\s*(?:"|'')?|\bbmi\b\W*\d+(?:[.,]\d+)?/gi;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const number = (value) => typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
const oneOf = (options) => (value) => {
  const text = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_]+/g, "-") : value;
  return options.includes(text) ? text : undefined;
};
const flag = (value) => value === true || value === "true" ? true : value === false || value === "false" ? false : undefined;
const text = (limit) => (value) => {
  if (typeof value !== "string") return undefined;
  return value.replace(MEASUREMENT, "").replace(/\s+/g, " ").trim().slice(0, limit) || undefined;
};
const colorNames = (value) => {
  const list = (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [])
    .filter((name) => typeof name === "string")
    .map((name) => name.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 30))
    .filter(Boolean);
  return list.length ? [...new Set(list)].slice(0, 12) : undefined;
};

const FIELDS = {
  hairLightness: oneOf(CHOICES.hairLightness),
  contrast: oneOf(CHOICES.contrast),
  skinDepth: (value) => { const level = number(value); return Number.isInteger(level) && level >= 1 && level <= 10 ? level : undefined; },
  undertone: oneOf(CHOICES.undertone),
  undertoneConfidence: oneOf(CHOICES.undertoneConfidence),
  greyHair: flag,
  heightCm: (value) => { const height = number(value); return height >= 100 && height <= 250 ? Math.round(height) : undefined; },
  fit: oneOf(CHOICES.fit),
  goals: text(200),
  lovedColors: colorNames,
  avoidedColors: colorNames,
  avoidNearFace: flag,
  rules: text(300),
};

// Keeps only known fields with valid values, so weight, measurements, or body descriptions never reach the file.
export function normalizeProfile(raw) {
  const input = isObject(raw) ? raw : {};
  const profile = { enabled: flag(input.enabled) ?? true };
  for (const [key, normalize] of Object.entries(FIELDS)) {
    const value = normalize(input[key]);
    if (value !== undefined) profile[key] = value;
  }
  if (!profile.undertone) delete profile.undertoneConfidence;
  const claimed = isObject(input.source) ? input.source : {};
  profile.source = Object.fromEntries(Object.keys(FIELDS).filter((key) => key in profile)
    .map((key) => [key, claimed[key] === "photo" && PHOTO_FIELDS.includes(key) ? "photo" : "user"]));
  if (typeof input.updatedAt === "string" && !Number.isNaN(Date.parse(input.updatedAt))) profile.updatedAt = input.updatedAt;
  return profile;
}

const active = (profile) => isObject(profile) && profile.enabled !== false && Object.keys(FIELDS).some((key) => profile[key] !== undefined);

// Undertone is easily misread from a photo, so it counts only once the wearer set it or the read was confident.
const undertoneSettled = (profile) => ["warm", "cool", "neutral", "olive"].includes(profile.undertone)
  && (profile.source?.undertone === "user" || profile.undertoneConfidence === "high");

// Every word of the listed color must appear in the garment's color name, so "green" covers "forest green".
const listed = (list = [], hex) => {
  const name = colorProfile(hex)?.name;
  if (!name) return null;
  const words = name.split(/[\s-]+/);
  return list.some((entry) => entry.split(/[\s-]+/).every((word) => words.includes(word))) ? name : null;
};

export function profileScore(look, profile) {
  if (!active(profile)) return { score: 0, notes: [] };
  const pieces = (look?.pieces || []).filter((item) => WORN.has(item?.part));
  const notes = [];
  let score = 0;

  // Outfit contrast: the widest lightness gap between the top or outer layer and the other clothes.
  const tones = pieces.filter((item) => item.part !== "shoes")
    .map((item) => ({ near: NEAR_FACE.has(item.part), lightness: colorProfile(item.color)?.lightness }))
    .filter((entry) => entry.lightness !== undefined);
  const gaps = tones.flatMap((a, index) => tones.slice(index + 1).filter((b) => a.near || b.near).map((b) => Math.abs(a.lightness - b.lightness)));
  if (profile.contrast && gaps.length) {
    const gap = Math.max(...gaps);
    const [low, high] = CONTRAST_BANDS[profile.contrast];
    const miss = Math.max(0, low - gap, gap - high);
    if (miss) {
      score -= 0.15 * Math.min(1, miss / 30);
      notes.push(`${gap < low ? "lower" : "higher"} contrast than your coloring`);
    } else {
      score += 0.03;
      notes.push(`suits your ${profile.contrast} contrast`);
    }
  }

  // Undertone: weak evidence (Perrett & Sprengelmeyer 2021), so the nudge stays tiny.
  const nearFace = pieces.filter((item) => NEAR_FACE.has(item.part)).map((item) => colorProfile(item.color)).filter(Boolean);
  if (undertoneSettled(profile) && profile.undertone !== "neutral" && nearFace.length) {
    const warm = profile.undertone !== "cool";
    const lean = nearFace.map((color) => {
      if (warm) return color.temperature === "warm" || color.role === "earth" ? 1 : color.temperature === "cool" ? -1 : 0;
      return color.temperature === "cool" || color.role === "base" ? 1 : color.temperature === "warm" || color.role === "earth" ? -1 : 0;
    }).reduce((sum, value) => sum + value, 0) / nearFace.length;
    if (lean) {
      score += 0.05 * lean;
      notes.push(lean > 0 ? `near-face colors suit your ${profile.undertone} undertone` : `near-face colors lean away from your ${profile.undertone} undertone`);
    }
  }

  // Avoided colors matter most near the face; away from it they cost little, or nothing when the wearer says so.
  let avoided = 0;
  for (const item of pieces) {
    const near = NEAR_FACE.has(item.part);
    if (!near && profile.avoidNearFace) continue;
    const primary = listed(profile.avoidedColors, item.color);
    const name = primary || listed(profile.avoidedColors, item.secondaryColor);
    if (!name) continue;
    avoided += (near ? 0.1 : 0.02) * (primary ? 1 : 0.5);
    notes.push(`avoided ${name} ${near ? "near the face" : "away from the face"}`);
  }
  score -= Math.min(0.15, avoided);

  let loved = 0;
  const lovedNames = new Set();
  for (const item of pieces) {
    const primary = listed(profile.lovedColors, item.color);
    const name = primary || listed(profile.lovedColors, item.secondaryColor);
    if (!name) continue;
    loved += primary ? 0.03 : 0.015;
    lovedNames.add(name);
  }
  if (lovedNames.size) notes.push(`includes loved ${list([...lovedNames])}`);
  score += Math.min(0.05, loved);

  return { score: Math.round(Math.min(0.1, Math.max(-0.2, score)) * 1000) / 1000, notes: [...new Set(notes)] };
}

function list(values) {
  return values.length > 1 ? `${values.slice(0, -1).join(", ")} and ${values.at(-1)}` : values[0] || "";
}

const sentence = (value) => value.replace(/[\s.;,]+$/, "");

// Context for the model prompts. Height never appears as a number, and nothing here judges the body.
export function profileSummary(profile) {
  if (!active(profile)) return "";
  const hair = [profile.hairLightness && `${profile.hairLightness} hair`, profile.greyHair && (profile.hairLightness ? "some grey" : "some grey hair")].filter(Boolean).join(", ");
  const coloring = [
    profile.contrast ? `${profile.contrast} personal contrast${hair ? ` (${hair})` : ""}` : hair,
    profile.skinDepth && `Monk skin depth ${profile.skinDepth}`,
    undertoneSettled(profile) && `${profile.undertone} undertone (${profile.source?.undertone === "user" ? "confirmed" : "from photo"})`,
  ].filter(Boolean).join(", ");
  const style = [profile.fit && `prefers ${profile.fit} fits`, profile.goals && `goals: ${sentence(profile.goals)}`].filter(Boolean).join("; ");
  const colors = [
    profile.lovedColors?.length && `loves ${list(profile.lovedColors)}`,
    profile.avoidedColors?.length && `avoids ${list(profile.avoidedColors)}${profile.avoidNearFace ? " near the face" : ""}`,
  ].filter(Boolean).join("; ");
  const parts = [coloring, style, colors, profile.rules && `rules: ${sentence(profile.rules)}`].filter(Boolean);
  if (!parts.length) return "";
  return `Wearer: ${parts.map((part, index) => index ? part.charAt(0).toUpperCase() + part.slice(1) : part).join(". ")}.`;
}

export function profileExtractionPrompt() {
  return [
    "This is the wearer's own reference photo in a personal wardrobe app. Describe their coloring so the app can weigh clothing colors. The wearer reviews and can change every value before anything is saved.",
    "Judge only what the photo shows. Give each value with a confidence of low, medium, or high, and use null for a value you cannot judge.",
    "- hairLightness: light | medium | dark",
    "- contrast: low | medium | high. Personal contrast is how much the hair and brows stand out from the skin in lightness. It compares areas lit by the same light, so it holds up better than undertone under colored light.",
    `- skinDepth: integer 1-10 on the Monk Skin Tone scale, 1 lightest to 10 deepest. Reference swatches: ${MONK_SCALE.map((hex, index) => `${index + 1} ${hex}`).join(", ")}.`,
    "- undertone: warm | cool | neutral | olive | unknown",
    "- greyHair: true | false",
    "Lighting changes how skin appears: warm light, such as late-afternoon sun or indoor bulbs, makes skin look warmer, and cool light makes it look cooler. Under warm or mixed light, undertone confidence must be low; answer unknown if you cannot tell. Allow for the light when judging skin depth, and lower that confidence when the light is strongly colored.",
    "Also describe the photo: framing (full-body | waist-up | face), lighting (neutral | warm | cool | mixed), and frontView (true when the person faces the camera directly).",
    "Do not estimate weight, body size, body shape, proportions, or measurements, and do not describe the body. Use neutral, descriptive language.",
    'Return JSON in this exact shape: {"hairLightness":{"value":"light|medium|dark","confidence":"low|medium|high"},"contrast":{"value":"low|medium|high","confidence":"..."},"skinDepth":{"value":<1-10>,"confidence":"..."},"undertone":{"value":"warm|cool|neutral|olive|unknown","confidence":"..."},"greyHair":{"value":true|false,"confidence":"..."},"photo":{"framing":"full-body|waist-up|face","lighting":"neutral|warm|cool|mixed","frontView":true|false}}',
  ].join("\n");
}

export function photoNote(photo = {}, confidence = {}) {
  const unsure = READ_FROM_PHOTO.filter((key) => confidence[key] === "low").map((key) => FIELD_NAMES[key]);
  const scene = `${FRAMING[photo.framing] || "Photo"}${photo.lighting ? ` in ${photo.lighting} light` : ""}${photo.frontView === false ? ", not a front view" : ""}`;
  return `${scene}${unsure.length ? `: ${list(unsure)} ${unsure.length > 1 ? "are" : "is"} uncertain` : ""}.`;
}

// Turns the vision model's answer into suggested fields with confidences. Nothing here is saved.
export function normalizeSuggestion(raw) {
  const input = isObject(raw) ? raw : {};
  const level = oneOf(CHOICES.undertoneConfidence);
  const suggestion = {};
  const confidence = {};
  for (const key of READ_FROM_PHOTO) {
    const entry = isObject(input[key]) ? input[key] : { value: input[key], confidence: input.confidence?.[key] };
    const value = FIELDS[key](entry.value);
    if (value === undefined) continue;
    suggestion[key] = value;
    confidence[key] = level(entry.confidence) || "low";
  }
  const shot = isObject(input.photo) ? input.photo : {};
  const photo = Object.fromEntries(Object.entries({
    framing: oneOf(Object.keys(FRAMING))(shot.framing), lighting: oneOf(LIGHTING)(shot.lighting), frontView: flag(shot.frontView),
  }).filter(([, value]) => value !== undefined));
  // Colored light shifts how skin reads, so such a photo cannot settle undertone.
  if (suggestion.undertone && ["warm", "mixed"].includes(photo.lighting)) confidence.undertone = "low";
  if (suggestion.undertone) suggestion.undertoneConfidence = confidence.undertone;
  return { suggestion, confidence, photo, note: photoNote(photo, confidence) };
}

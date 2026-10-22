// Shared by the server and the item editor, so this module must stay free of Node imports.

const CLOTHING = ["upperbody", "lowerbody", "wholebody_up"];
const WORN = [...CLOTHING, "shoes"];
const ALL = [...WORN, "accessories_up"];

export const PART_LABELS = {
  upperbody: "top",
  lowerbody: "bottom",
  wholebody_up: "outer layer",
  accessories_up: "accessory",
  shoes: "shoes",
};

export const CATEGORIES = {
  upperbody: ["tshirt", "tank", "polo", "henley", "dress_shirt", "casual_shirt", "blouse", "sweater", "sweatshirt", "hoodie", "top", "other"],
  wholebody_up: ["overshirt", "cardigan", "blazer", "suit_jacket", "jacket", "coat", "vest", "zip_hoodie", "other"],
  lowerbody: ["jeans", "chinos", "dress_trousers", "trousers", "cargos", "joggers", "shorts", "skirt", "other"],
  shoes: ["athletic_sneakers", "casual_sneakers", "minimal_sneakers", "loafers", "dress_shoes", "boots", "sandals", "heels", "flats", "other"],
  accessories_up: ["watch", "bag", "belt", "hat", "scarf", "eyewear", "jewelry", "tie", "other"],
};

export const ATTRIBUTE_FIELDS = [
  { key: "category", label: "Type", parts: ALL },
  { key: "formality", label: "Formality", parts: ALL, values: [1, 2, 3, 4, 5], names: { 1: "Athletic", 2: "Casual", 3: "Smart casual", 4: "Dressy", 5: "Formal" } },
  { key: "warmth", label: "Warmth", parts: WORN, values: [0, 1, 2, 3, 4], names: { 0: "Hot weather", 1: "Light", 2: "Medium", 3: "Warm", 4: "Cold weather" } },
  { key: "fabric", label: "Fabric", parts: ALL, values: ["cotton", "linen", "denim", "wool", "knit", "jersey", "fleece", "corduroy", "flannel", "synthetic", "technical", "silk", "leather", "suede", "canvas", "mesh", "metal", "other"] },
  { key: "texture", label: "Texture", parts: WORN, values: ["smooth", "medium", "rough"] },
  { key: "pattern", label: "Pattern", parts: CLOTHING, values: ["solid", "stripe", "check", "floral", "print", "graphic", "textured"] },
  { key: "patternScale", label: "Pattern scale", parts: CLOTHING, values: ["none", "small", "medium", "large"] },
  { key: "fit", label: "Fit", parts: CLOTHING, values: ["slim", "regular", "relaxed", "oversized"] },
  { key: "sleeve", label: "Sleeves", parts: ["upperbody", "wholebody_up"], values: ["none", "short", "long"] },
  { key: "hem", label: "Hem", parts: ["upperbody"], values: ["straight", "tails"] },
  { key: "legShape", label: "Leg", parts: ["lowerbody"], values: ["slim", "tapered", "straight", "wide"] },
  { key: "shoeProfile", label: "Profile", parts: ["shoes"], values: ["sleek", "medium", "chunky"] },
  { key: "leather", label: "Leather", parts: ["shoes", "accessories_up"], values: ["none", "black", "brown", "tan", "other"] },
  { key: "statement", label: "Statement piece", parts: ALL, values: [true, false] },
];

export function fieldsForPart(part) {
  return ATTRIBUTE_FIELDS
    .filter((field) => field.parts.includes(part))
    .map((field) => field.key === "category" ? { ...field, values: CATEGORIES[part] || ["other"] } : field);
}

export function valueLabel(field, value) {
  if (field.names?.[value]) return field.names[value];
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const text = String(value).replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function normalizeAttributes(raw, part) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const result = {};
  for (const field of fieldsForPart(part)) {
    let value = source[field.key];
    if (typeof value === "string") value = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (field.values.every((option) => typeof option === "number")) value = Number.isFinite(Number(value)) && value !== "" && value !== null ? Math.round(Number(value)) : undefined;
    if (field.key === "statement" && typeof value === "string") value = value === "true" ? true : value === "false" ? false : undefined;
    if (typeof value === "string") value = field.values.find((option) => String(option).replace(/_/g, "") === value.replace(/_/g, "")) ?? value;
    if (field.values.includes(value)) result[field.key] = value;
  }
  if (result.pattern === "solid") result.patternScale = "none";
  return result;
}

export function attributePrompt(item) {
  const fields = fieldsForPart(item.part);
  const line = (key, text) => fields.some((field) => field.key === key) ? `- ${key}: ${text}` : null;
  const options = (key) => fields.find((field) => field.key === key)?.values.join(" | ");
  const colors = [item.color, item.secondaryColor].filter(Boolean).map(colorPhrase).join(" and ");
  return [
    `You are cataloguing one garment from a personal wardrobe so a stylist can combine it with the owner's other pieces. The image shows it as a product cutout on a plain grey background.`,
    `Known details: name "${item.name}"; slot: ${PART_LABELS[item.part] || item.part}; colors: ${colors || "unknown"}; tags: ${(item.tags || []).join(", ") || "none"}.`,
    "Judge the garment you can see. Use null for anything you cannot tell. Return one JSON object with these keys:",
    line("category", options("category")),
    line("formality", "integer 1-5. 1 = athletic or lounge (running shoes, joggers, gym wear). 2 = casual (tees, hoodies, jeans, cargos, flannels, casual sneakers). 3 = smart casual (polos, casual button-ups, chinos, minimal leather sneakers, loafers). 4 = dressy or business (dress shirts, tailored trousers, blazers, derbies). 5 = formal (suits, tuxedos, oxfords). Smooth, dark, plain, structured pieces read more formal; rough, light, bold or busy pieces read less formal."),
    line("warmth", "integer 0-4. 0 = hot weather only (linen, tanks, shorts, sandals). 1 = light (tees, shirts, polos, cotton trousers, sneakers). 2 = medium (sweatshirts, hoodies, flannels, overshirts, light jackets, jeans). 3 = warm (heavy knits, fleece, wool or lined jackets, boots). 4 = cold-weather outerwear (parkas, puffers, heavy wool coats)."),
    line("fabric", `${options("fabric")}. Choose the dominant visible material.`),
    line("texture", "smooth | medium | rough"),
    line("pattern", options("pattern")),
    line("patternScale", "none | small | medium | large (none when solid)"),
    line("fit", options("fit")),
    line("sleeve", options("sleeve")),
    line("hem", "tails (curved shirt tails meant to be tucked) | straight (designed to be worn untucked)"),
    line("legShape", options("legShape")),
    line("shoeProfile", "sleek (slim, low profile) | medium | chunky (thick sole or bulky upper)"),
    line("leather", "the leather color if any leather is visible (straps, uppers, trims), else none"),
    line("statement", "true when the piece would be the focal point of most outfits (bold color, large print, graphic, unusual cut), otherwise false"),
  ].filter(Boolean).join("\n");
}

// Color descriptors from hex, in CIELAB so lightness and chroma match perception.

const COLOR_NAMES = [
  ["black", "#141414", "base"], ["charcoal", "#36393d", "base"], ["dark grey", "#55585c", "base"], ["grey", "#8a8d90", "base"],
  ["light grey", "#c9cacb", "base"], ["white", "#f5f5f2", "base"], ["off-white", "#ece6d8", "base"], ["cream", "#efe3c4", "base"],
  ["beige", "#d8c7a6", "base"], ["stone", "#bfb5a2", "base"], ["navy", "#1d2840", "base"], ["light blue", "#c8daf0", "base"],
  ["denim blue", "#4a6080", "base"], ["taupe", "#8b7d6b", "earth"], ["khaki", "#b9a77c", "earth"], ["tan", "#c6a466", "earth"],
  ["camel", "#c19a6b", "earth"], ["brown", "#7b5234", "earth"], ["dark brown", "#4a3322", "earth"], ["olive", "#6b6d3a", "earth"],
  ["dark olive", "#46492c", "earth"], ["army green", "#556349", "earth"], ["dark green", "#2f3b31", "earth"], ["sage", "#9caf88", "earth"], ["burgundy", "#6e2a3a", "accent"], ["plum", "#5b3a52", "accent"],
  ["red", "#b3332e", "accent"], ["rust", "#a5502e", "accent"], ["terracotta", "#c0663f", "accent"], ["orange", "#e07b39", "accent"],
  ["mustard", "#c9a227", "accent"], ["yellow", "#ecd04b", "accent"], ["forest green", "#2c4a35", "accent"], ["green", "#3f7d4b", "accent"],
  ["mint", "#b5dcc4", "accent"], ["teal", "#2a7072", "accent"], ["sky blue", "#8fb8e0", "accent"], ["blue", "#2f5aa0", "accent"],
  ["cobalt", "#1f4fbf", "accent"], ["slate blue", "#4f6378", "accent"], ["purple", "#5f4a8b", "accent"], ["lavender", "#b4a6d6", "accent"],
  ["pink", "#e6a4b4", "accent"], ["dusty pink", "#c99a9e", "accent"], ["coral", "#e8836e", "accent"],
];
const ROLE_LABELS = { base: "base neutral", earth: "earth neutral", accent: "accent" };
const HEX = /^#[0-9a-f]{6}$/i;

export function lab(hex) {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const f = (value) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const NAMED = COLOR_NAMES.map(([name, hex, role]) => ({ name, role, lab: lab(hex) }));

export function colorProfile(hex) {
  if (typeof hex !== "string" || !HEX.test(hex)) return null;
  const [lightness, a, b] = lab(hex);
  const chroma = Math.hypot(a, b);
  const hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  const nearest = NAMED.reduce((best, entry) => {
    const distance = Math.hypot(...entry.lab.map((value, index) => value - [lightness, a, b][index]));
    return distance < best.distance ? { ...entry, distance } : best;
  }, { distance: Infinity });
  const role = chroma < 7 ? "base" : nearest.role;
  const temperature = chroma < 8 ? "neutral" : hue < 105 || hue >= 340 ? "warm" : hue >= 165 && hue < 300 ? "cool" : "neutral";
  return {
    name: nearest.name,
    lightness: Math.round(lightness),
    chroma: Math.round(chroma),
    tone: lightness < 35 ? "dark" : lightness > 72 ? "light" : "mid",
    temperature,
    role,
  };
}

export function colorPhrase(hex) {
  const profile = colorProfile(hex);
  if (!profile) return "";
  const notes = [profile.tone, profile.temperature === "neutral" ? null : profile.temperature, ROLE_LABELS[profile.role]].filter(Boolean);
  return `${profile.name} (${notes.join(", ")})`;
}

export function describeItem(item, handle = item.id) {
  const attributes = normalizeAttributes(item.attributes, item.part);
  const fields = fieldsForPart(item.part).filter((field) => attributes[field.key] !== undefined);
  const value = (key) => attributes[key];
  const details = [
    value("category") && valueLabel(fields.find((field) => field.key === "category"), value("category")).toLowerCase(),
    value("formality") !== undefined && `formality ${value("formality")}/5`,
    value("warmth") !== undefined && `warmth ${value("warmth")}/4`,
    [value("fabric"), value("texture"), value("pattern") && (value("pattern") === "solid" ? "solid" : `${value("patternScale") && value("patternScale") !== "none" ? `${value("patternScale")} ` : ""}${value("pattern")}`)].filter(Boolean).join(", "),
    value("sleeve") && value("sleeve") !== "none" && `${value("sleeve")} sleeve`,
    value("hem") === "tails" ? "shirt tails, tuck in" : value("hem") === "straight" ? "straight hem, wear untucked" : null,
    value("fit") && `${value("fit")} fit`,
    value("legShape") && `${value("legShape")} leg`,
    value("shoeProfile") && `${value("shoeProfile")} profile`,
    value("leather") && value("leather") !== "none" && `${value("leather")} leather`,
    value("statement") && "statement piece",
  ].filter(Boolean);
  const colors = [item.color, item.secondaryColor].map(colorPhrase).filter(Boolean).join(" + ");
  return [
    handle,
    PART_LABELS[item.part] || item.part,
    item.name,
    colors || "color unknown",
    details.length ? details.join("; ") : "not described yet",
    (item.tags || []).length ? `tags: ${item.tags.join(", ")}` : null,
  ].filter(Boolean).join(" | ");
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { chatJson, llmSettings, visionModel } from "./llm-client.mjs";
import { normalizeProfile, normalizeSuggestion, profileExtractionPrompt } from "./profile.mjs";

const BASE = "/api/profile";

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

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

// The saved profile, normalized again so a hand-edited file cannot carry extra fields. Empty when none is saved.
export async function readProfile(dataDir) {
  try { return normalizeProfile(JSON.parse(await readFile(path.join(dataDir, "profile.json"), "utf8"))); }
  catch (error) { if (error.code === "ENOENT") return normalizeProfile({}); throw error; }
}

export function profileApi(options = {}) {
  let root;
  let dataDir;
  let queue = Promise.resolve();
  const setting = (name, fallback = "") => options.env?.[name] || process.env[name] || fallback;
  const llm = () => llmSettings(setting);
  const reference = () => path.resolve(root, setting("WARDROBE_MODEL_REFERENCE", "data/model-reference.png"));
  const hasReference = async () => {
    try { return (await stat(reference())).isFile(); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  };

  async function handler(req, res, next) {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return next();
    try {
      if (url.pathname === BASE && req.method === "GET") {
        return send(res, 200, { profile: await readProfile(dataDir), hasReference: await hasReference(), hasLlm: llm().configured });
      }
      if (url.pathname === BASE && req.method === "PUT") {
        const body = await input(req);
        const save = queue.then(async () => {
          const previous = await readProfile(dataDir);
          const profile = normalizeProfile(body);
          // A field the client did not attribute keeps its source while unchanged; a changed one is the user's.
          for (const key of Object.keys(profile.source)) {
            if (body.source?.[key] === undefined && JSON.stringify(profile[key]) === JSON.stringify(previous[key])) profile.source[key] = previous.source[key] || "user";
          }
          profile.updatedAt = new Date().toISOString();
          await atomicJson(path.join(dataDir, "profile.json"), profile);
          return profile;
        });
        queue = save.catch(() => {});
        return send(res, 200, { profile: await save });
      }
      if (url.pathname === `${BASE}/suggest` && req.method === "POST") {
        if (!llm().configured) throw bad("Configure WARDROBE_LLM_API_KEY or WARDROBE_LLM_BASE_URL in .env and restart the app.", 422);
        if (!await hasReference()) throw bad("Add data/model-reference.png first.", 422);
        const image = await sharp(await readFile(reference())).rotate()
          .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
          .toColorspace("srgb").jpeg({ quality: 90 }).toBuffer();
        let raw;
        try { raw = await chatJson({ ...llm(), model: visionModel(setting), prompt: profileExtractionPrompt(), image, mime: "image/jpeg", timeout: 180000 }); }
        catch (error) { throw bad(`The LLM could not read the photo: ${error.message}`, 502); }
        return send(res, 200, normalizeSuggestion(raw));
      }
      throw bad("Profile route not found.", 404);
    } catch (error) {
      return send(res, error.status || 500, { error: error.status ? error.message : "Internal profile error." });
    }
  }

  return {
    name: "wardrobe-profile-api",
    apply: "serve",
    async configResolved(config) {
      root = config.root;
      dataDir = path.resolve(root, setting("WARDROBE_DATA_DIR", "data"));
      await mkdir(dataDir, { recursive: true });
    },
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

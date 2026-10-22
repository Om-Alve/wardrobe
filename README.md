<div align="center">

# Wardrobe

Your clothes, extracted and organized with gpt-image.

[![License: MIT](https://img.shields.io/badge/license-MIT-191919?style=flat-square)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-191919?style=flat-square)](package.json)

[See the original post →](https://x.com/cdngdev/status/2076812846793650485)

</div>

![Wardrobe gallery](docs/screenshots/gallery.png)

![Modeled wardrobe editor](docs/screenshots/editor.png)

## Quick start

```bash
git clone https://github.com/tandpfun/wardrobe.git
cd wardrobe
npm install
cp .env.example .env
npm run dev
```

⚠️ The importer needs an LLM endpoint, `OPENAI_IMAGE_API_KEY` in `.env`, and a PNG reference photo at `data/model-reference.png`. Outfit ideas need only the LLM endpoint.

Open [localhost:5173](http://localhost:5173).

## Import with Codex

This repo includes two Codex skills: one imports clothes and generates modeled item photos; the other styles complete outfits and generates a modeled lookbook.

```text
$import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
$generate-outfits Create modeled outfit ideas from my wardrobe.
```

Open the cloned repo in Codex and run either prompt. The import skill asks for a local model-reference PNG when needed, reviews every cutout and modeled photo, then writes to `data/library.json` and `data/imported/`. The outfit skill asks how many looks to create, then curates, generates, verifies, and saves the complete collection under `data/`.

## Trips and outfit ideas

Open **Trips & outfits** in the app. You can ask for ideas from the whole wardrobe or create named trips with separate packing lists. Each trip item can be **planned**, **packed**, or **worn / laundry**. Trip suggestions use only packed and worn items; they flag worn items so you can decide whether to reuse them. For any request, you can narrow the selected items and choose an anchor piece.

Describe the occasion and what you want, choose the number of looks, and optionally enter weather conditions. If a trip has a destination and near-term dates, the app can fetch a forecast from [Open-Meteo](https://open-meteo.com/en/docs); your own conditions take precedence. The stylist sees each garment's formality, warmth, fabric, pattern, fit, and named colors. For every request the model first sets a plan: the formality range the occasion needs, the warmest base pieces the weather allows, whether a removable outer layer makes sense, and any pieces your request asks for or rules out. The app then builds every look that fits that plan, ranks them by your history (recently worn pieces rest, underused ones rise, pairings you saved, liked, or wore get a lift) and by common styling conventions, and shows the model a shuffled, varied shortlist to choose from, so every suggestion is a valid look. When the wardrobe lacks something the occasion needs, such as dress shoes, the looks leave that slot out and say so, and you get fewer looks rather than padded ones. Rate a look with thumbs up or down and mark it **Wore it**; a thumbs-down keeps that top and bottom pairing out of suggestions. Revisions prefer changing a single piece. [Sanzo Wada's color combinations](https://github.com/mattdesl/dictionary-of-colour-combinations) remain loose color inspiration.

Suggestions are saved locally as drafts in `data/stylist.json`. Ask the stylist to revise a draft, save a combination as an outfit, and assign a saved trip outfit to a day. These actions work without an image API key. **See how it looks** stays disabled until an image key and model reference are available; clicking it then generates a modeled photo for that look only. The result stays in `data/outfit-images/`, and you can review or regenerate it. API keys stay in the local server environment. In the outfit flow, garment and identity images are sent to OpenAI only when you request a modeled photo.

The trip list and outfit flow took inspiration from [toop-closet's suitcases](https://github.com/akleventis/toop-closet) and [mywardrobe's anchor piece and supporting neutrals](https://github.com/newbie1668/mywardrobe). The included Wada color data is MIT licensed; see [its license notice](scripts/WADA-DATA-LICENSE.md).

### What to buy next

On the Clothes page, **What to buy next** reviews your wardrobe for the occasions you dress for, which start from the ones you have asked the stylist about. The model plans each occasion and proposes pieces to buy; the app then adds each proposal to your wardrobe as a hypothetical item and counts the new complete outfits it unlocks: a distinct top and bottom you can wear with shoes, and with a layer when the occasion needs one. Pieces are ordered greedily, so each step shows what it adds on top of the pieces before it, and a first outfit for an occasion counts for more than a fifth outfit for one you already cover. Pieces that would repeat an earlier pick appear as alternatives, and near-twins of what you own are pointed out rather than ranked. The last review is saved.

### Profile

Open **Profile** to describe your coloring and preferences: skin depth on the Monk Skin Tone scale, hair, personal contrast, undertone, fit, goals, colors you love or avoid, and your own rules. **Suggest from my photo** sends your reference photo to the configured model once and fills in suggestions with a confidence for each; nothing is saved until you review it and click Save. Undertone counts only once you confirm it or the photo reading is confident, since lighting changes how skin looks. The profile adds a short description of you to the stylist's prompts and gently favors looks whose contrast and colors suit you; it never rules a look out, never stores weight or measurements, and never sends your height to the model. Switch it off at any time.

### For agents

If you are setting up Wardrobe for a user, ask how they want to import their clothes:

- **Codex:** Ask for a folder or camera-roll location and a model-reference PNG, then extract, model, and import the individual pieces by following [the bundled import skill](.agents/skills/import-clothes/SKILL.md). Afterward, offer to create a requested number of modeled looks with [the outfit-generation skill](.agents/skills/generate-outfits/SKILL.md).
- **Web UI:** Help the user configure an LLM endpoint, `OPENAI_IMAGE_API_KEY`, and `data/model-reference.png`, then let them import through the app.

## What it does

- Detects every garment in a photo with a vision-capable OpenAI-compatible chat model
- Extracts clean product cutouts with the OpenAI Images API
- Describes each cutout's type, formality, warmth, fabric, pattern, and fit with the vision model; you can correct any of them in the item editor
- Generates an optional modeled editorial preview
- Keeps originals, jobs, generated images, and the JSON database local in `data/`
- Supports drag, drop, paste, editing, review, regeneration, and approval

Garment cutouts use a 1024 × 1024 transparent canvas. To reframe older local imports, preview with `npm run normalize:garments`, then run `npm run normalize:garments:apply`. The command saves the original PNGs in `data/original-garments/` before replacing them. To describe garments imported before attributes existed, preview with `npm run describe:garments`, then run `npm run describe:garments:apply`; garments you edited by hand are never overwritten.

## Configuration

| Variable | Default |
| --- | --- |
| `WARDROBE_LLM_API_KEY` | Key for hosted chat model; blank for a local endpoint |
| `WARDROBE_LLM_BASE_URL` | `https://api.openai.com/v1` |
| `WARDROBE_LLM_MODEL` | `gpt-5.4-mini` |
| `WARDROBE_VISION_MODEL` | `WARDROBE_LLM_MODEL` |
| `WARDROBE_STYLIST_MODEL` | `WARDROBE_LLM_MODEL` |
| `WARDROBE_REASONING_EFFORT` | Provider default; `none` makes outfit suggestions much faster on models that support it |
| `OPENAI_IMAGE_API_KEY` | Required only for cutouts and modeled photos |
| `OPENAI_IMAGE_BASE_URL` | `https://api.openai.com/v1` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png` |
| `WARDROBE_DATA_DIR` | `data` |

For a local [Ollama OpenAI-compatible endpoint](https://docs.ollama.com/api/openai-compatibility), set `WARDROBE_LLM_BASE_URL=http://localhost:11434/v1` and `WARDROBE_LLM_MODEL` to an installed model. Leave `WARDROBE_LLM_API_KEY` blank. Outfit suggestions work with a text model; photo imports need a vision-capable model, which you can select with `WARDROBE_VISION_MODEL`. The LLM must return JSON that follows the app's requested shape. Keep `OPENAI_IMAGE_API_KEY` separate for image generation. Existing `OPENAI_API_KEY` is accepted as a fallback for both services until you split the configuration; a custom LLM URL never receives that legacy key.

Run `npm run check` to build the app and exercise the trip and outfit API with local fixtures. The image API call in that check is mocked, so it does not need an API key or incur usage. `npm run eval:live` runs a fixed set of briefs against your configured model on a copy of your wardrobe and writes a report to `data/evals/`; it calls the model, so it uses your API quota.

## License

[MIT](LICENSE)

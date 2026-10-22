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

Describe the occasion and what you want, choose the number of looks, and optionally enter weather conditions. If a trip has a destination and near-term dates, the app can fetch a forecast from [Open-Meteo](https://open-meteo.com/en/docs); your own conditions take precedence. The stylist uses [Sanzo Wada's color combinations](https://github.com/mattdesl/dictionary-of-colour-combinations) as inspiration while allowing useful neutrals. It validates every suggested item against the selected wardrobe set.

Suggestions are saved locally as drafts in `data/stylist.json`. Ask the stylist to revise a draft, save a combination as an outfit, and assign a saved trip outfit to a day. These actions work without an image API key. **See how it looks** stays disabled until an image key and model reference are available; clicking it then generates a modeled photo for that look only. The result stays in `data/outfit-images/`, and you can review or regenerate it. API keys stay in the local server environment. In the outfit flow, garment and identity images are sent to OpenAI only when you request a modeled photo.

The trip list and outfit flow took inspiration from [toop-closet's suitcases](https://github.com/akleventis/toop-closet) and [mywardrobe's anchor piece and supporting neutrals](https://github.com/newbie1668/mywardrobe). The included Wada color data is MIT licensed; see [its license notice](scripts/WADA-DATA-LICENSE.md).

### For agents

If you are setting up Wardrobe for a user, ask how they want to import their clothes:

- **Codex:** Ask for a folder or camera-roll location and a model-reference PNG, then extract, model, and import the individual pieces by following [the bundled import skill](.agents/skills/import-clothes/SKILL.md). Afterward, offer to create a requested number of modeled looks with [the outfit-generation skill](.agents/skills/generate-outfits/SKILL.md).
- **Web UI:** Help the user configure an LLM endpoint, `OPENAI_IMAGE_API_KEY`, and `data/model-reference.png`, then let them import through the app.

## What it does

- Detects every garment in a photo with a vision-capable OpenAI-compatible chat model
- Extracts clean product cutouts with the OpenAI Images API
- Generates an optional modeled editorial preview
- Keeps originals, jobs, generated images, and the JSON database local in `data/`
- Supports drag, drop, paste, editing, review, regeneration, and approval

## Configuration

| Variable | Default |
| --- | --- |
| `WARDROBE_LLM_API_KEY` | Key for hosted chat model; blank for a local endpoint |
| `WARDROBE_LLM_BASE_URL` | `https://api.openai.com/v1` |
| `WARDROBE_LLM_MODEL` | `gpt-5.4-mini` |
| `WARDROBE_VISION_MODEL` | `WARDROBE_LLM_MODEL` |
| `WARDROBE_STYLIST_MODEL` | `WARDROBE_LLM_MODEL` |
| `OPENAI_IMAGE_API_KEY` | Required only for cutouts and modeled photos |
| `OPENAI_IMAGE_BASE_URL` | `https://api.openai.com/v1` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png` |
| `WARDROBE_DATA_DIR` | `data` |

For a local [Ollama OpenAI-compatible endpoint](https://docs.ollama.com/api/openai-compatibility), set `WARDROBE_LLM_BASE_URL=http://localhost:11434/v1` and `WARDROBE_LLM_MODEL` to an installed model. Leave `WARDROBE_LLM_API_KEY` blank. Outfit suggestions work with a text model; photo imports need a vision-capable model, which you can select with `WARDROBE_VISION_MODEL`. The LLM must return JSON that follows the app's requested shape. Keep `OPENAI_IMAGE_API_KEY` separate for image generation. Existing `OPENAI_API_KEY` is accepted as a fallback for both services until you split the configuration; a custom LLM URL never receives that legacy key.

Run `npm run check` to build the app and exercise the trip and outfit API with local fixtures. The image API call in that check is mocked, so it does not need an API key or incur usage.

## License

[MIT](LICENSE)

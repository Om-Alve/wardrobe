# Wardrobe

A local app for cataloging your clothes, planning outfits, and seeing selected looks on a model. Import photos through the app or with the bundled Codex skills. Wardrobe keeps its library, outfit history, and generated images in `data/` on your machine.

[![License: MIT](https://img.shields.io/badge/license-MIT-191919?style=flat-square)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-191919?style=flat-square)](package.json)

[Original post](https://x.com/cdngdev/status/2076812846793650485)

![Wardrobe gallery](docs/screenshots/gallery.png)

![Modeled wardrobe editor](docs/screenshots/editor.png)

## Get started

Use Node.js 22 or later. Clone the repo, install dependencies, and start the local server:

```bash
git clone https://github.com/tandpfun/wardrobe.git
cd wardrobe
npm ci
cp .env.example .env
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The gallery opens without API keys. To plan outfits or import photos, configure an OpenAI-compatible chat endpoint in `.env` with `WARDROBE_LLM_API_KEY`, or set `WARDROBE_LLM_BASE_URL` and `WARDROBE_LLM_MODEL` for a local endpoint. Photo imports need a vision-capable chat model.

To extract garment cutouts or generate modeled photos, also set `OPENAI_IMAGE_API_KEY`. Modeled photos need a PNG reference photo at `data/model-reference.png`. Restart the server after editing `.env`. See [Configuration](#configuration) for all options.

## Use your wardrobe

| Page | What you can do |
| --- | --- |
| **Clothes** | Import photos, review garment cutouts, edit colors and attributes, and browse your library. **What to buy next** estimates the complete outfits a proposed item would add. |
| **Planner** | Ask for looks by occasion, weather, or anchor piece. Create trips with packing lists and plan outfits from the packed items. |
| **Outfits** | Browse the lookbook, save combinations, and revisit saved outfits. |
| **Profile** | Set color and fit preferences and your own styling rules. You can also request suggestions from a reference photo and review them before saving. |

The planner builds valid combinations from your clothes before asking the model to pick and explain them. It considers formality, warmth, garment attributes, your profile, and feedback from looks you saved, liked, disliked, or wore. If the wardrobe cannot make enough suitable looks, it returns fewer. You can revise a draft, save it, mark it worn, or generate a modeled photo with **See how it looks**.

Trips track each item as planned, packed, or worn. Trip suggestions use packed and worn items, with a warning for worn pieces. For trips with a destination and near-term dates, **Check destination weather** gets a forecast from [Open-Meteo](https://open-meteo.com/en/docs). Conditions you enter take precedence.

The lookbook groups outfits by style and shows color combinations that match the included [Sanzo Wada dictionary dataset](https://github.com/mattdesl/dictionary-of-colour-combinations). See the [dataset license](scripts/WADA-DATA-LICENSE.md).

## Import and generate with Codex

Open the cloned repo in Codex and use either bundled skill:

```text
$import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
$generate-outfits Create modeled outfit ideas from my wardrobe.
```

[Import clothes](.agents/skills/import-clothes/SKILL.md) extracts individual garments, reviews the cutouts and modeled photos, and adds them to `data/library.json` and `data/imported/`. [Generate outfits](.agents/skills/generate-outfits/SKILL.md) curates a requested number of looks and saves the collection under `data/`. Both skills ask for missing inputs, including a local model-reference PNG when needed.

You can also import through **Clothes** in the web app. The importer detects garments with the vision model, extracts transparent 1024 × 1024 cutouts with the Images API, and describes each item's type, formality, warmth, fabric, pattern, and fit. Review and correct the results before adding them to the library.

## Configuration

Copy `.env.example` to `.env` and set the services you intend to use. API keys stay in the local server environment. The app sends photos to the configured model when you request analysis, cutouts, or modeled images.

| Variable | Purpose or default |
| --- | --- |
| `WARDROBE_LLM_API_KEY` | Chat API key. Leave blank for a local endpoint. |
| `WARDROBE_LLM_BASE_URL` | Chat endpoint. Defaults to `https://api.openai.com/v1`. |
| `WARDROBE_LLM_MODEL` | Chat model. Defaults to `gpt-5.4-mini`. |
| `WARDROBE_VISION_MODEL` | Model for photo analysis. Defaults to `WARDROBE_LLM_MODEL`. |
| `WARDROBE_STYLIST_MODEL` | Model for outfit suggestions. Defaults to `WARDROBE_LLM_MODEL`. |
| `WARDROBE_REASONING_EFFORT` | Optional provider setting. `none` can reduce suggestion latency on supported models. |
| `OPENAI_IMAGE_API_KEY` | Required for garment cutouts and modeled photos. |
| `OPENAI_IMAGE_BASE_URL` | Images endpoint. Defaults to `https://api.openai.com/v1`. |
| `OPENAI_IMAGE_MODEL` | Image model. Defaults to `gpt-image-2`. |
| `OPENAI_IMAGE_QUALITY` | Image quality. Defaults to `high`. |
| `WARDROBE_MODEL_REFERENCE` | PNG reference photo. Defaults to `data/model-reference.png`. |
| `WARDROBE_DATA_DIR` | Local data directory. Defaults to `data`. |

For a local [Ollama OpenAI-compatible endpoint](https://docs.ollama.com/api/openai-compatibility), set `WARDROBE_LLM_BASE_URL=http://localhost:11434/v1` and `WARDROBE_LLM_MODEL` to an installed model. Leave `WARDROBE_LLM_API_KEY` blank. Outfit suggestions need a text model; photo imports need a vision model. The chat model must return JSON in the shape the app requests.

The app accepts `OPENAI_API_KEY` as a fallback for both services. A custom chat URL does not receive that legacy key.

## Local data and maintenance

Personal photos, generated assets, and the JSON library live in `data/`, which Git ignores. The app also saves trip and outfit drafts in `data/stylist.json`. Do not commit `.env` or `data/`.

To reframe older garment images, run `npm run normalize:garments` to preview changes, then `npm run normalize:garments:apply` to write them. The apply command backs up the original PNGs in `data/original-garments/`.

To add attributes to older imports, run `npm run describe:garments` to preview, then `npm run describe:garments:apply`. Hand-edited attributes are preserved.

## Develop

Run `npm run check` to build the app and exercise the trip, outfit, import, and profile APIs with local fixtures. Its image API call is mocked, so the check does not need an API key. `npm run eval:live` runs fixed outfit briefs against your configured model on a copy of the wardrobe and writes a report to `data/evals/`. It uses your model quota.

The [demo video script](demo/script.md) describes the recording and editing tools in `demo/`. Recordings and renders go in the ignored `demo/out/` directory.

## Credits and license

Trip packing lists and outfit selection took inspiration from [toop-closet](https://github.com/akleventis/toop-closet) and [mywardrobe](https://github.com/newbie1668/mywardrobe). Wardrobe is licensed under [MIT](LICENSE).

# Wardrowbe features to adopt

This doc reviews [wardrowbe](https://github.com/Anyesh/wardrowbe) at commit `bbe090e` (22 Oct 2026) and maps its features onto our roadmap. Wardrowbe paths are relative to its repo root; ours are relative to `wardrobe/`. Every formula below was read from the source.

## Bottom line

Wardrowbe scores items, sends the top 70 as a numbered list to one LLM call that returns three outfits, and repairs the answer in code. Its tagging vocabulary, recency and underuse curves, feedback weights and wear bookkeeping are worth borrowing. Its recommender is not: the scorer switches off below 50 items (`MIN_ITEMS_FOR_SCORING` in `backend/app/services/item_scorer.py`), so with our 17 items it would be a plain LLM call over an unordered list that the prompt still calls "pre-ranked". Our step 2 plan is stronger, and nothing here argues for changing it.

## License

Wardrowbe is MIT-licensed ("Copyright (c) 2026 Anish S."), like our repo, so we may port its code, prompts and data directly, provided we ship its copyright and permission notice with the ported material, as `scripts/WADA-DATA-LICENSE.md` does for the Wada data. Little is worth porting verbatim, because it is Python on Postgres and scores items rather than outfits. Each section marks reuse as **port** (copied, notice required) or **reimplement** (our own code from the idea, no notice needed).

## Features

### 1. Item tagging

**What it does.** `backend/app/prompts/clothing_analysis.txt` is the system message and the photo is the user message (`analyze_image` in `services/ai_service.py`). The vocabulary in `backend/app/data/garment_vocabulary.json` has 32 types with body roles and wash intervals, 15 materials, a six-step formality scale, 22 occasions mapped to allowed formality levels, and 20 named colors. `_parse_tags_from_response` keeps only in-vocabulary values. Confidence combines field completeness with, when the endpoint returns logprobs, a weighted minimum token probability per field (type 0.30, color 0.25, others 0.15). `TaggedBy` marks tags `auto` or `manual`.

**Verdict: adapt.** Step 1 already has a richer attribute set and exact hex colors. It lacks two wardrowbe ideas: provenance, so re-enrichment never overwrites a correction, and per-field confidence, so the user confirms only uncertain fields.

**Our mapping.** `normalizeAttributes` in `scripts/garment-attributes.mjs` already drops out-of-vocabulary values, and `colorProfile` already works in CIELAB. Add a `schema` option to `chatJson` in `scripts/llm-client.mjs` that sends the enums as a JSON schema, and store `attributeSource` (per field, `"auto"` or `"user"`) and `attributeConfidence` beside `attributes` in `library.json`. Fabric is the least reliable field from a cutout and drives warmth and texture, so it should be the first one offered for confirmation.

*Effort S · step 1 · reuse: reimplement.*

### 2. Item scorer

**What it does.** `score_items` multiplies six per-item factors, then adds a pair bonus.

| Factor | Rule |
|---|---|
| Weather | Cold below 10 °C, hot above 25 °C; "high" sensitivity moves both 5 °C inward. Cold: warm layers, wool, fleece, knit or winter-tagged items 1.0, shorts, tanks and sandals 0.05, else 0.7. Hot: cotton, linen, silk or summer-tagged 1.0, warm layers and boots 0.05, else 0.8. A swing of 8 °C or more averages both ends, with a 0.6 hot-end floor for light removable layers. Rain above 50 % adds 0.1 to jackets, coats and hoodies. |
| Formality | 1.0 if allowed for the occasion, 0.5 one step away, 0.15 further. |
| Season | 1.0 in season, untagged, or matching a hot or cold day; 0.6 for an adjacent season; 0.2 otherwise. |
| Recency | 0.1 if worn today, else min(1, 0.1 + 0.9 × days since worn ÷ avoid_days), with avoid_days 7 by default. |
| Preference | 1.0, +0.1 favorite color, −0.3 avoided, +0.05 learned favorite, −0.15 learned avoid, up to +0.1 for learned styles; clamped to 0.3–1.2. |
| Underuse | By wear count ÷ median: 1.15 at ≤0.3, 1.05 at ≤0.7, 1.0 at ≤1.5, else 0.9. |
| Pair bonus | Within the top 20 only: +0.05 per learned partner also there, capped at 0.15. |

**Verdict: improve.** Per-item scores cannot see what makes an outfit work, which is the relation between pieces. The product also blurs hard and soft rules, because a 0.05 acts as a ban but reads as a preference. We should keep the recency curve, underuse ratio and removable-layer floor as inputs to a look-level score.

**Our mapping.** `recommendationIssues` in `scripts/stylist-core.mjs` already checks a formality floor, a spread above 2, and warmth on hot and cold days, but only after generation. Step 2 moves these into a new `scripts/outfit-engine.mjs` (`enumerateLooks`, `hardViolations`, `softScore`) so they filter before the LLM sees anything. Warmth becomes arithmetic: derive a target from the daily low and high that `forecastFor` returns and keep the core within one point of it. Keep the spread limit of 2 as a hard rule with a soft penalty at 2; a limit of 1 would leave few smart looks while our only shoes are running sneakers.

**Further.** Encode the Put This On and Die Workwear rules as soft terms: dark, smooth and plain pieces read more formal, shoes set the formality floor, a look carries one accent or statement at most, and patterns mix only at different scales. Use ΔE2000 on the CIELAB values for tonal matches, and compare the top–bottom lightness gap with the user's personal contrast. `relevantPalettes` still uses RGB distance and should move to ΔE. Later, fit the weights from pairwise feedback instead of tuning them by hand.

*Effort M · step 2 · reuse: reimplement; the constants are ideas, not code.*

### 3. Candidate shortlist and prompts

**What it does.** `_ensure_role_diversity` keeps at least four bottoms and four shoes in the top 70 by promoting them from the tail. `_format_items_for_prompt` in `services/recommendation_service.py` writes lines such as `[n] "name" | type | colors | material | formality | season | worn N days ago | pairs well with: [a]`. `prompts/recommendation.txt` adds weather and occasion, tells the model at line 8 to "prefer items near the top of the list", gives styling principles (monochrome, neutral plus accent or analogous color, texture contrast, balanced volume), and asks for three outfits as item numbers. `prompts/item_pairing.txt` builds outfits around one item from the whole wardrobe, unscored and without weather or wash filters.

**Verdict: adapt the format, reject the ordering.** Short handles beat our current full ids such as `import-874d5d03-…`, which waste tokens and invite copying errors. An ordered list with "prefer the top" builds position bias in on purpose.

**Our mapping.** In the suggest handler of `scripts/stylist-api.mjs`, replace the `describeItem` list with 20–30 complete looks from `outfit-engine.mjs`, shuffled and labelled `L1…Ln`, each listing its pieces by handles such as `T3`. The schema becomes `{"picks":[{"look":"L7","name":"…","reason":"…"}]}` with `look` an enum of the labels. An anchor filters the pool, which covers pairing.

**Further.** As a selector over valid candidates, the LLM can no longer produce invalid looks. The eval should run each brief with two shortlist orders and report pick agreement as a measure of position bias.

*Effort M · step 2 · reuse: the styling paragraph could be ported with the notice, but most of it becomes code.*

### 4. Validation and retries

**What it does.** Wardrowbe checks structure only and never re-asks the model. `resolve_outfit_items` drops unknown numbers, `deduplicate_by_body_slot` in `utils/clothing.py` drops a second item per slot, `remove_legwear` drops tights on hot days, and `fill_missing_regions` adds a missing top, bottom or shoe, flagging it only in the stored raw response. `generate_text` retries transport errors up to three times per endpoint with backoff. Nothing checks distinctness, the avoid list, formality or color.

**Verdict: skip, apart from deterministic repair.** Our `validateLook`, `recommendationIssues` and corrective retry already check more, and after step 2 validity holds by construction. Keep the retry for schema errors, repair an invalid revision to the nearest valid look in code, and count every repair and retry in the step 5 eval rather than hiding them as wardrowbe does.

*Effort S · step 2 · reuse: reimplement.*

### 5. Feedback and learning

**What it does.** `UserFeedback` (`models/outfit.py`) records accept or reject, a 1–5 rating, worn date, modifications, "did not wear it" and what was worn instead. `services/learning_service.py` derives:

- **Outfit signal** (`_get_outfit_signal`): +0.3 accepted, −0.5 rejected, 0.4 × rating mapped to −1…+1, +0.3 worn (−0.1 if modified), −0.4 if not worn; clamped to −1…+1.
- **Learned colors and styles**: each item's color and style tags take the outfit's signal, averaged from as little as one observation; colors above 0.2 count as favorites and below −0.2 as avoided.
- **Pair compatibility**: every item pair in an outfit with any feedback is tallied, scoring 0 below two co-occurrences and otherwise (acceptance rate × 0.6 + rating × 0.4) × 2 − 1, with 0.5 for a missing part. Pairs above 0.3 feed the pair bonus.
- **Same-day reject exclusion** (`_get_today_rejected_item_ids`): every item of every outfit rejected today for that occasion leaves the candidate pool.

Several knobs are dead: `SCORE_DECAY_RATE`, `MANUAL_SIGNAL_MULTIPLIER`, `wear_bonus`, the `excluded_combinations` preference, and `suggestion_count`.

**Verdict: adapt the signals, fix credit assignment.** Spreading one verdict over every item and pair learns slowly and often wrongly. A worn-only outfit scores its pairs at exactly 0, so wearing, the strongest signal, never strengthens a pair. Same-day exclusion would remove our only shoes after one reject.

**Our mapping.** Add to `stylist.json` a `looks[].verdict` (`"up"`, `"down"` or null), a `wears` log of `{date, garmentIds, lookId}` fed by "Wore it" with an editable item set, a `neverPair` list, and `swaps` of `{lookId, out, in, at}`. A new `scripts/feedback.mjs` derives recency, wear counts and pair scores per request, which at our scale beats materialized tables and a cron. `neverPair` is a hard rule.

**Further.** Smooth pair scores with a Beta(2, 2) prior, weight wears above thumbs, and decay events with a 90-day half-life. A thumbs-down can offer an optional tap on the offending piece. Revisions should follow Fashion++: make the single swap with the largest score gain, which keeps the rest of the look and records a clean preference for one item over another. Exclude only the rejected top–bottom pair for the session.

*Effort M · step 4 · reuse: reimplement; their weights are fair starting priors.*

### 6. Variety and "try another"

**What it does.** The prompt lists item sets worn in the last 7 days and the last 10 suggested in 12 hours, asking the model not to repeat them, and nothing checks the answer. Single-look `/suggest` requests cache the two unused outfits in Redis for an hour (`services/suggestion_cache.py`), reusing one only if temperature is within 3 °C and the other context matches. The main page's "try another" discards all three looks and regenerates.

**Verdict: improve.** With every valid look enumerated, "try another" is the next pick from the scored pool and needs no cache and usually no LLM call.

**Our mapping.** Add `mmrSelect(scored, n, λ)` to `outfit-engine.mjs`, which repeatedly picks the look maximizing λ × score − (1 − λ) × its highest similarity to looks already chosen or recently shown, using weighted Jaccard over items and λ ≈ 0.7. Garment sets shown or worn in the last N days are a hard filter from `looks[].createdAt` and `wears`. The eval reports intra-list diversity and wardrobe coverage.

*Effort S · step 2 · reuse: reimplement.*

### 7. Personal data

**What it does.** `record_wears` in `services/item_service.py` logs each wear and updates `wear_count` and `last_worn_at`. Items drop out after a per-type wash interval (t-shirt 1 wear, jeans 6). `api/analytics.py` lists most, least and never-worn items, color and type shares, and rule-based insights such as a tops-to-bottoms ratio above 3. Cost-per-wear does not exist: `purchase_price` is stored and never read. `users.body_measurements` (height, weight, chest, waist, hips, inseam, sizes) is pasted verbatim into the prompt with one generic line ("taller frames carry volume better") and never scored. There is no skin, undertone or contrast data.

**Verdict.** Adopt the wear log. Skip wash tracking, since trips already mark worn items. Add an optional `price` field for cost-per-wear. Replace color-share analytics with versatility, and never send raw measurements to the model.

**Our mapping.** `outfit-engine.mjs` reports each item's count of valid looks, flags orphans with one or none, and `wardrobeGaps` scores candidate purchases, described with step 1 attributes, by the new looks each unlocks. Capsule-wardrobe research defines versatility the same way. The step 3 profile goes in a new `data/profile.json` (contrast, Monk swatch, undertone with confidence, height, fit and proportion goals, colors, rules), each field user-confirmed and used only as soft terms such as a preferred lightness gap.

*Effort S for the wear log and price, M for versatility, L for the profile · steps 2–4 · reuse: reimplement.*

### 8. Other features

| Feature | What wardrowbe does | Verdict |
|---|---|---|
| Scheduled suggestions | Weekly schedules push a look by ntfy, Mattermost or email (`workers/notifications.py`). | Skip; we have no always-on worker. |
| Wearing window | Today's range runs from now to 21:00 (`_wearing_window` in `services/weather_service.py`). | Adopt for same-day requests; S. |
| Calendar | In-app history calendar, no external sync. | Skip; trip days cover planning. |
| Family | Shared households whose ratings never reach learning. | Skip. |
| Wore instead | Logging what was really worn learns from it (`services/studio_service.py`). | Adopt within "Wore it"; S. |
| External agent mode | `AI_INTERNAL_ENABLED=false` hands suggestions to an outside agent. | Let the `generate-outfits` skill call `outfit-engine.mjs`; S. |
| Quality evaluation | None; tests mock the model. | Build in step 5, adding a pairwise LLM judge run in both orders and calibrated against blind A/B picks. |

## Build order

| # | Work | Files | Step | Effort |
|---|---|---|---|---|
| 1 | Enum schema, provenance, confidence | `garment-attributes.mjs`, `llm-client.mjs` | 1 | S |
| 2 | Enumerate looks; hard rules for formality, warmth, patterns, anchor, never-pair | `outfit-engine.mjs` (new) | 2 | M |
| 3 | Frozen briefs with violation, retry and diversity metrics | `eval-outfits.mjs` | 5 | M |
| 4 | Shuffled look shortlist with handles and enum schema | `stylist-api.mjs` | 2 | M |
| 5 | Soft score with ΔE color, texture, formality distance | `outfit-engine.mjs` | 2 | M |
| 6 | MMR, "try another" from the pool, recent-set filter | `outfit-engine.mjs` | 2 | S |
| 7 | Verdicts, "Wore it", never-pair, derived pair scores | `feedback.mjs` (new), `stylist.json` | 4 | M |
| 8 | Minimal single-swap revisions | `outfit-engine.mjs`, `stylist-api.mjs` | 2 | M |
| 9 | Versatility report and best next purchase | `outfit-engine.mjs` | 2 | M |
| 10 | User-confirmed profile as soft terms | `profile.mjs` (new), `data/profile.json` | 3 | L |
| 11 | Blind A/B pick page | new `src` component | 5 | S–M |
| 12 | Cost-per-wear | `library.json` | 4 | S |

The eval comes third so that every later change is measured against a baseline.

## What not to copy

- The "prefer the top of the list" instruction, or any candidate list in score order.
- Constraints stated only in the prompt, such as avoiding recent outfits, with no check afterwards.
- Silent repair of model output, which hides failure rates.
- Outfit-level verdicts spread over every item and pair, colors learned from one observation, and whole-item exclusion after a reject.
- Raw body measurements in the prompt.
- Settings that nothing reads, such as `SCORE_DECAY_RATE` and `excluded_combinations`.
- Learning tables refreshed by cron, when our data is small enough to derive per request.
- A per-item score that activates only at 50 items, and color logic built on 20 color names.

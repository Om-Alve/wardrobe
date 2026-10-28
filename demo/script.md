# Wardrobe demo video

About 2½ minutes at 1920×1080. Every shot fills whole bars, and clicks and results land on beats. Everything is recorded from the real app and the real Codex CLI. The public README copy is silent and obscures faces, the camera roll, and local paths.

## Shots

| Bars | Time | Shot | Caption |
|---|---|---|---|
| 0–2 | 0:00 | Title card, with garments from the new wardrobe arriving on the beat | |
| 2–3 | 0:05 | Camera-roll thumbnails scrolling past | Point Codex at your camera roll |
| 3–10 | 0:08 | Codex runs `$import-clothes` as a time-lapse, with the real elapsed time in the title bar | It finds every garment, cuts each one out, and adds it to your wardrobe |
| 10–16 | 0:26 | The new wardrobe: filters, then one piece and its style fields | Every piece is described, from formality and warmth to fabric and fit |
| 16–21 | 0:41 | Profile: Suggest from my photo, add a rule, save | Your profile tells the stylist about your coloring and your rules |
| 21–32 | 0:54 | Planner: dinner with friends at 24°C, three looks with reasons, a thumbs-up, a revision, then save | Describe the occasion and the weather / The stylist picks from every look that fits what the occasion needs / Thumbs, wears and revisions teach it your taste |
| 32–36 | 1:21 | See how it looks: a photo of you in the saved look | See any look on you before you wear it |
| 36–43 | 1:31 | A Lisbon trip: packing list, forecast, then ideas from the packed pieces | Trips get a packing list and a forecast / and their outfit ideas use only what you packed |
| 43–48 | 1:49 | What to buy next, with an occasion added | What to buy next counts the outfits each piece would add |
| 48–56 | 2:02 | The lookbook: genres, Wada swatches, save, Saved | The lookbook collects your best outfits, grouped by style / and checks their colors against Sanzo Wada's colour dictionary |
| 56–58 | 2:22 | End card | |

## How it's made

- **Separate copy.** `~/wardrobe-demo/wardrobe` is a fresh clone of this branch with its own `data/`. Your real data isn't touched.
- **Codex.** It runs in a tmux pane recorded by asciinema. `demo/terminal.mjs` turns the recording into a time-lapse page:
  - The pasted command and prompt are revealed keystroke by keystroke.
  - The run is compressed into a few seconds.
- **Recording.** `demo/record.mjs` drives the app with agent-browser and records Chrome's own screencast at 60 fps. It logs every pointer move, click and named moment on the frames' clock.
- **Editing.** `demo/edit.mjs` builds a Cap project with one segment per scene. It exports without audio unless you pass `--song` with a track you can publish:
  - **Cursor.** A cursor track is drawn from the logged clicks.
  - **Timing.** Named moments are placed on half-beats, and model waits are cut on a beat.
  - **Overlays.** Captions sit below the app, and zooms only come in when no caption is showing.
  - **Export.** It renders the project with `cap export`.
- **Rendering again.**
  - With the recordings in hand, `node demo/edit.mjs` cuts and exports the video again.
  - `node demo/record.mjs --only planner` records a single scene again.

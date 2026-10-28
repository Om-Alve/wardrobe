#!/usr/bin/env node
// Cuts the recorded scenes to the beat timeline in a Cap project and exports it.
// Each shot fills whole bars. Named moments in a recording (a click, results arriving) land on half-beats:
// a few are pinned by hand, the rest are spread at an even pace between them. Waits for the model are cut
// on a beat. Captions and zooms are anchored to beats or to those moments, so everything moves with the music.
// Usage: node demo/edit.mjs [--scenes dir] [--only planner,trip] [--song licensed-track.mp3] [--no-export]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportProject, setConfig, writeProject } from "./lib/cap.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index === -1 ? fallback : args[index + 1]; };
const out = fileURLToPath(new URL("./out/", import.meta.url));
const scenesDir = path.resolve(option("scenes", path.join(out, "scenes")));
const songFile = option("song", "");
const song = songFile ? path.resolve(songFile) : null;
const project = path.resolve(option("project", path.join(out, "wardrobe-demo.cap")));
const output = path.resolve(option("output", path.join(out, "wardrobe-demo.mp4")));
const only = option("only", "")?.split(",").filter(Boolean);

const { beats } = JSON.parse(await readFile(path.join(out, "beats.json"), "utf8"));
const beatLength = (beats.at(-1) - beats[0]) / (beats.length - 1);
// Song time of beat n; bar b starts at beat 4b. Fractions fall between detected beats.
const beat = (n) => {
  const index = Math.floor(n);
  const base = beats[index] ?? beats[0] + index * beatLength;
  return base + (n - index) * ((beats[index + 1] ?? base + beatLength) - base);
};

// keys: [mark, beat within the shot] pins a moment; [mark] places it automatically.
// "@start" and "@end" are the recording's ends. cuts: marks whose wait beforehand is cut out.
// zooms: [from, to, amount, "auto" or {x, y}]; captions: [from, to, text]. From and to are beats in the
// shot, or [mark, beats after it].
const SHOTS = [
  { scene: "title", bars: [0, 2], keys: [["start", 0]] },
  { scene: "roll", bars: [2, 3], keys: [["start", 0], ["bottom", 4]], captions: [[0.25, 3.8, "Point Codex at your camera roll"]] },
  { scene: "terminal", bars: [3, 10], keys: [["play", 0]],
    captions: [[0.5, 27.6, "It finds every garment, cuts each one out, and adds it to your wardrobe"]] },
  { scene: "wardrobe", bars: [10, 16], keys: [["start", 1], ["tops"], ["bottoms"], ["shoes"], ["all"], ["open", 10], ["style"], ["close", 22], ["@end", 24]],
    captions: [[1, ["style", -0.4], "Every piece is described, from formality and warmth to fabric and fit"]],
    zooms: [[["style", 0], ["close", -0.5], 1.45, { x: 0.82, y: 0.62 }]] },
  { scene: "profile", bars: [16, 21], keys: [["start", 1], ["suggest"], ["suggested", 6], ["rule"], ["save"], ["@end", 20]], cuts: ["suggested"],
    captions: [[1, ["suggested", -0.4], "Your profile tells the stylist about your coloring and your rules"]],
    zooms: [[["suggested", 0], ["suggested", 6], 1.35, { x: 0.42, y: 0.42 }]] },
  { scene: "planner", bars: [21, 32], keys: [["start", 1], ["occasion"], ["suggest", 12], ["results", 15], ["reasons", 17], ["thumbs", 23], ["revise-open"], ["revise"], ["revised"], ["save", 38], ["open-saved"], ["photo", 44]], cuts: ["results", "revised"],
    captions: [[1, 11.6, "Describe the occasion and the weather"], [["suggest", 0], ["reasons", -0.4], "The stylist picks from every look that fits what the occasion needs"],
      [["thumbs", 0], ["revised", -0.4], "Thumbs, wears and revisions teach it your taste"]],
    zooms: [[["reasons", 0], ["thumbs", -0.5], 1.4, { x: 0.6, y: 0.42 }], [["revised", 0], ["save", -0.5], 1.35, { x: 0.6, y: 0.5 }]] },
  { scene: "planner", bars: [32, 36], keys: [["photo", 0], ["photo-ready", 4], ["@end", 16]], cuts: ["photo-ready"],
    captions: [[0.5, ["photo-ready", -0.4], "See any look on you before you wear it"]],
    zooms: [[["photo-ready", 0], 15.5, 1.3, "auto"]] },
  { scene: "trip", bars: [36, 43], keys: [["start", 1], ["created"], ["packing"], ["packed"], ["weather"], ["forecast"], ["suggest"], ["results", 24], ["@end", 28]], cuts: ["forecast", "results"],
    captions: [[1, ["packed", -0.4], "Trips get a packing list and a forecast"], [["packed", 0], 27.6, "and their outfit ideas use only what you packed"]] },
  { scene: "buy", bars: [43, 48], keys: [["start", 1], ["run"], ["results", 8], ["coverage"], ["ranked"], ["@end", 20]], cuts: ["results"],
    captions: [[1, ["ranked", -0.4], "What to buy next counts the outfits each piece would add"]],
    zooms: [[["ranked", 0], 19.5, 1.3, "auto"]] },
  { scene: "lookbook", bars: [48, 56], keys: [["start", 1], ["genre-1"], ["swatches"], ["genre-2"], ["filter"], ["saved"], ["saved-tab"], ["@end", 32]],
    captions: [[1, ["swatches", -0.4], "The lookbook collects your best outfits, grouped by style"], [["genre-2", 0], 31.6, "and checks their colors against Sanzo Wada's colour dictionary"]],
    zooms: [[["swatches", 0], ["genre-2", -0.5], 1.6, "auto"]] },
  { scene: "end", bars: [56, 58], keys: [["start", 0]] },
];

const MAX_SPEED = 2.8;
const MIN_SPEED = 0.6;
const CUT_KEEP = 1.1; // seconds of a cut wait that stay on screen, split around the jump
const snap = (value) => Math.round(value * 2) / 2;

// Places every moment of a shot on a half-beat, keeping pinned ones and spreading the rest at an even pace.
function place(shot, recording) {
  const length = 4 * (shot.bars[1] - shot.bars[0]);
  const source = (mark) => mark === "@start" ? 0 : mark === "@end" ? recording.duration : recording.marks[mark];
  const keys = shot.keys.map(([mark, at]) => ({ mark, at, source: source(mark) })).filter((key) => key.source !== undefined);
  if (keys.at(-1).at === undefined) keys.at(-1).at = length;
  if (keys[0].at === undefined) keys[0].at = 0;
  const weight = (a, b) => (shot.cuts?.includes(b.mark) ? Math.min(b.source - a.source, CUT_KEEP) : b.source - a.source);
  for (let start = 0; start < keys.length - 1;) {
    let end = start + 1;
    while (keys[end].at === undefined) end += 1;
    const total = keys.slice(start, end).reduce((sum, key, index) => sum + Math.max(0.05, weight(key, keys[start + index + 1])), 0);
    let elapsed = 0;
    for (let index = start + 1; index < end; index += 1) {
      elapsed += Math.max(0.05, weight(keys[index - 1], keys[index]));
      const ideal = keys[start].at + (keys[end].at - keys[start].at) * (elapsed / total);
      keys[index].at = Math.min(Math.max(snap(ideal), keys[index - 1].at + 0.5), keys[end].at - 0.5 * (end - index));
    }
    start = end;
  }
  return keys;
}

const shots = SHOTS.filter((shot) => !only?.length || only.includes(shot.scene));
const names = [...new Set(shots.map((shot) => shot.scene))];
const recordings = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(scenesDir, name, "timeline.json"), "utf8"))));
// A partial render starts the song where its first shot sits, so the cut still lands on the same beats.
const songOffset = shots[0] === SHOTS[0] ? 0 : beat(4 * shots[0].bars[0]);

const segments = [];
const zoomSegments = [];
const textSegments = [];
const report = [];

for (const shot of shots) {
  const recordingSegment = names.indexOf(shot.scene);
  const recording = recordings[recordingSegment];
  const missing = shot.keys.filter(([mark, at]) => at !== undefined && mark[0] !== "@" && recording.marks[mark] === undefined).map(([mark]) => mark);
  if (missing.length) { report.push(`${shot.scene} [${shot.bars}]: skipped, no ${missing.join(", ")}`); continue; }
  const first = 4 * shot.bars[0];
  // The title starts with the song itself, before the first beat.
  const songAt = (b) => (shot === SHOTS[0] && b === 0 ? 0 : beat(first + b));
  const keys = place(shot, recording);
  const placed = Object.fromEntries(keys.map((key) => [key.mark, key.at]));
  const resolve = (spec) => (Array.isArray(spec) ? placed[spec[0]] + spec[1] : spec);
  const knots = keys.map((key) => ({ ...key, out: songAt(key.at) }));
  const end = songAt(4 * (shot.bars[1] - shot.bars[0]));
  // The first and last pinned moments may sit inside the shot; play into and out of them at normal speed.
  if (knots[0].out > songAt(0) + 1e-6) knots.unshift({ mark: "@lead", source: Math.max(0, knots[0].source - (knots[0].out - songAt(0))), out: songAt(0) });
  if (knots.at(-1).out < end - 1e-6) knots.push({ mark: "@hold", source: Math.min(recording.duration, knots.at(-1).source + (end - knots.at(-1).out)), out: end });
  const line = [];
  for (let index = 0; index < knots.length - 1; index += 1) {
    const a = knots[index];
    const b = knots[index + 1];
    const span = b.out - a.out;
    const length = b.source - a.source;
    if (span <= 1e-6) continue;
    if (shot.cuts?.includes(b.mark) && length > span * 1.2) {
      // Jump cut on the beat nearest the middle: play into the wait, then rejoin just before the moment.
      const jump = Math.min(Math.max(songAt(snap((a.at + b.at) / 2)), a.out + 0.1), b.out - 0.1);
      segments.push({ recordingSegment, timescale: 1, start: a.source, end: a.source + (jump - a.out), name: `${shot.scene} ${a.mark}` });
      segments.push({ recordingSegment, timescale: 1, start: b.source - (b.out - jump), end: b.source, name: `${shot.scene} cut to ${b.mark}` });
      line.push(`${b.mark}@${b.at} cut`);
      continue;
    }
    if (length <= 0.02) {
      // Nothing left to play: hold the frame.
      segments.push({ recordingSegment, timescale: 0.02, start: Math.max(0, a.source - span * 0.02), end: Math.max(0.02, a.source), name: `${shot.scene} hold` });
      continue;
    }
    const speed = length / span;
    if (speed > MAX_SPEED || speed < MIN_SPEED) line.push(`!${a.mark}→${b.mark} ${speed.toFixed(2)}×`);
    else if (b.mark[0] !== "@") line.push(`${b.mark}@${b.at} ${speed.toFixed(2)}×`);
    segments.push({ recordingSegment, timescale: speed, start: a.source, end: b.source, name: `${shot.scene} ${a.mark}` });
  }
  report.push(`${shot.scene} [${shot.bars}]: ${line.join(", ")}`);
  for (const [from, to, amount, mode] of shot.zooms || []) {
    zoomSegments.push({ start: songAt(resolve(from)) - songOffset, end: songAt(resolve(to)) - songOffset, amount, mode: mode === "auto" ? "auto" : { manual: mode },
      glideDirection: "none", glideSpeed: 0.5, instantAnimation: false, edgeSnapRatio: 0.25 });
  }
  for (const [from, to, text] of shot.captions || []) {
    textSegments.push({ start: songAt(resolve(from)) - songOffset, end: songAt(resolve(to)) - songOffset, track: 0, enabled: true, content: text,
      center: { x: 0.5, y: 0.946 }, size: { x: 0.92, y: 0.07 }, fontFamily: "Helvetica Neue", fontSize: 64, fontWeight: 500, italic: false, color: "#23211e", fadeDuration: 0.25 });
  }
}

const total = segments.reduce((sum, segment) => sum + (segment.end - segment.start) / segment.timescale, 0);
const config = await writeProject(project, recordings, "Wardrobe demo");
config.background = { ...config.background, source: { type: "gradient", from: [238, 233, 222], to: [214, 205, 188], angle: 135 }, padding: 20, rounding: 7, roundingType: "squircle", shadow: 55, displayPosition: { x: 0.5, y: 0.46 } };
config.cursor = { ...config.cursor, hide: false, size: 150, type: "auto", animationStyle: "mellow", hideWhenIdle: false, motionBlur: 0.5, useSvg: true };
config.timeline = {
  segments, zoomSegments, textSegments, sceneSegments: [], maskSegments: [], captionSegments: [], keyboardSegments: [],
  audioSegments: song ? [{ start: 0, end: total, track: 0, path: song, name: path.basename(song), enabled: true, trimStart: songOffset, volumeDb: -2, fadeIn: 0, fadeOut: 2.5, duration: total + songOffset }] : [],
};
await setConfig(project, config);
console.log(report.join("\n"));
console.log(`${segments.length} clips, ${zoomSegments.length} zooms, ${textSegments.length} captions, ${total.toFixed(2)}s`);
if (!args.includes("--no-export")) console.log(`Exported ${await exportProject(project, output)}`);

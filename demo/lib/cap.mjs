// Builds a Cap Studio project from recorded scenes: one recording segment per scene, a cursor track drawn
// from the logged pointer events, and an editor configuration that the Cap CLI renders.
import { execFile } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const assets = fileURLToPath(new URL("../assets/", import.meta.url));
const CURSORS = {
  arrow: { id: "0", imagePath: "content/cursors/cursor_0.png", hotspot: { x: 0.17857142857142858, y: 0.125 }, shape: "MacOS|TahoeArrow" },
  text: { id: "1", imagePath: "content/cursors/cursor_1.png", hotspot: { x: 0.5217391304347826, y: 0.5 }, shape: "MacOS|TahoeIBeam" },
  hand: { id: "2", imagePath: "content/cursors/cursor_2.png", hotspot: { x: 0.40625, y: 0.25 }, shape: "MacOS|TahoePointingHand" },
};

export async function cap(...args) {
  const { stdout } = await run("cap", args.map(String), { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function cursorTrack(scene) {
  const moves = [];
  const clicks = [];
  let kind = "arrow";
  for (const event of [...scene.events].sort((a, b) => a.t - b.t)) {
    if (event.t < 0) continue;
    if (event.type === "move") {
      kind = event.kind || kind;
      moves.push({ active_modifiers: [], cursor_id: CURSORS[kind].id, time_ms: event.t * 1000, x: event.x / scene.width, y: event.y / scene.height });
    } else if (event.type === "down" || event.type === "up") {
      clicks.push({ active_modifiers: [], cursor_num: 0, cursor_id: CURSORS[kind].id, time_ms: event.t * 1000, down: event.type === "down" });
    }
  }
  return { moves, clicks };
}

export async function writeProject(projectDir, scenes, name) {
  await rm(projectDir, { recursive: true, force: true });
  await mkdir(path.join(projectDir, "content", "cursors"), { recursive: true });
  for (const cursor of Object.values(CURSORS)) await copyFile(path.join(assets, "cursors", path.basename(cursor.imagePath)), path.join(projectDir, cursor.imagePath));
  const segments = [];
  for (const [index, scene] of scenes.entries()) {
    const dir = path.join(projectDir, "content", "segments", `segment-${index}`);
    await mkdir(dir, { recursive: true });
    await copyFile(scene.video, path.join(dir, "display.mp4"));
    const segment = { display: { path: `content/segments/segment-${index}/display.mp4`, fps: 60, start_time: 0 } };
    // Scenes without a pointer park Cap's cursor outside the frame, so none is drawn.
    const track = scene.events?.some((event) => event.type === "move") ? cursorTrack(scene)
      : { moves: [{ active_modifiers: [], cursor_id: CURSORS.arrow.id, time_ms: 0, x: 2, y: 2 }], clicks: [] };
    await writeFile(path.join(dir, "cursor.json"), JSON.stringify(track));
    segment.cursor = `content/segments/segment-${index}/cursor.json`;
    segments.push(segment);
  }
  const cursors = Object.fromEntries(Object.values(CURSORS).map(({ id, ...cursor }) => [id, cursor]));
  await writeFile(path.join(projectDir, "recording-meta.json"), JSON.stringify({ platform: "MacOS", pretty_name: name, sharing: null, segments, cursors, status: { status: "Complete" } }, null, 2));
  return JSON.parse(await cap("project", "config", "get", projectDir, "--json"));
}

export async function setConfig(projectDir, config) {
  await cap("project", "config", "set", projectDir, "--settings-json", JSON.stringify(config));
}

export async function exportProject(projectDir, output, { width = 1920, height = 1080, fps = 60 } = {}) {
  await cap("export", projectDir, "--output", output, "--resolution", `${width}x${height}`, "--fps", fps, "--quality", "maximum", "--json");
  return output;
}

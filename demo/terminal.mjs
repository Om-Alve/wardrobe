#!/usr/bin/env node
// Turns the asciinema recording of the Codex import into a time-lapse page for the demo.
// The pasted command and prompt are revealed as if typed, the trust prompt and the long run are compressed,
// and the window shows the real elapsed time while the run is sped up.
// Usage: node demo/terminal.mjs --cast ~/wardrobe-demo/codex.cast --seconds 17.5 [--done-text "count: 20"]
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index === -1 ? fallback : args[index + 1]; };
const castFile = path.resolve(option("cast", path.join(process.env.HOME, "wardrobe-demo", "codex.cast")));
const seconds = Number(option("seconds", "17.5"));
const pages = fileURLToPath(new URL("./out/pages/", import.meta.url));

const [header, ...lines] = (await readFile(castFile, "utf8")).split("\n").filter((line) => line.trim() && !line.startsWith("#"));
const meta = JSON.parse(header);
let clock = 0;
const events = lines.map((line) => { const [interval, kind, data] = JSON.parse(line); clock += interval; return { t: clock, kind, data }; }).filter((event) => event.kind === "o");
const plain = (data) => data.replace(/\x1b\[[0-9;?<>=]*[A-Za-z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g, "");
const find = (test, after = 0) => events.findIndex((event) => event.t > after && test(event));

const command = find((event) => plain(event.data).includes("codex --approve-for-me"));
const trust = find((event) => plain(event.data).includes("Folder access"), events[command].t);
const accepted = find((event) => plain(event.data).includes("OpenAI Codex"), events[trust].t + 0.5);
const prompt = find((event) => plain(event.data).includes("$import-clothes"), events[accepted].t);
const working = find((event) => event.data.includes("7501;state=working"), events[prompt].t + 1);
let idle = events.length - 1;
for (let index = events.length - 1; index > working; index -= 1) {
  if (events[index].data.includes("7501;state=working")) break;
  if (events[index].data.includes("7501;state=idle")) idle = index;
}
// --done-text ends the run at a line of output instead, for a session that stopped before going idle.
const doneText = option("done-text", "");
const doneAt = doneText ? find((event) => plain(event.data).includes(doneText), events[working].t) : -1;
const done = doneAt === -1 ? events[idle].t : events[doneAt].t + 1.2;
const runStart = events[working].t;

// Output time for each moment: [real time, output time]. Between anchors time runs linearly.
const typeCommand = 0.9;
const typePrompt = 1.7;
const hold = 2.6;
const anchors = [];
let out = 0;
const at = (real, gap) => { out += gap; anchors.push([real, out]); };
at(events[command].t - 0.9, 0);
at(events[command].t, 0.9 + typeCommand);
at(events[trust].t + 0.2, events[trust].t + 0.2 - events[command].t);
at(events[trust].t + 0.9, 0.7);
at(events[accepted].t - 0.05, 0.05);
at(events[prompt].t, 0.5);
at(events[prompt].t + 0.01, typePrompt);
at(runStart, 0.5);
const lapse = seconds - out - hold;
at(done + 0.6, lapse);
at(done + 0.6 + hold, hold);
const map = (real) => {
  if (real <= anchors[0][0]) return 0;
  for (let index = 1; index < anchors.length; index += 1) {
    const [r0, o0] = anchors[index - 1];
    const [r1, o1] = anchors[index];
    if (real <= r1) return o0 + ((real - r0) / (r1 - r0 || 1)) * (o1 - o0);
  }
  return anchors.at(-1)[1];
};

// Splits a pasted burst into keystrokes: escape sequences stay whole, printable characters come one at a time.
const keystrokes = (data) => data.match(/\x1b\[[0-9;?<>=]*[A-Za-z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]|[\s\S]/gu);
const output = [];
for (const [index, event] of events.entries()) {
  if (event.t > anchors.at(-1)[0]) continue;
  // Whatever was on screen before the clip starts is drawn in its first frame.
  if (event.t < anchors[0][0]) { output.push([0, event.data]); continue; }
  if (index === command || index === prompt) {
    const pieces = keystrokes(event.data);
    const visible = pieces.filter((piece) => !piece.startsWith("\x1b")).length;
    const span = index === command ? typeCommand : typePrompt;
    const start = index === command ? map(event.t) - typeCommand : map(event.t) + 0.005;
    let shown = 0;
    let chunk = "";
    for (const piece of pieces) {
      chunk += piece;
      if (piece.startsWith("\x1b")) continue;
      shown += 1;
      output.push([start + (span * shown) / visible, chunk]);
      chunk = "";
    }
    if (chunk) output.push([start + span, chunk]);
    continue;
  }
  output.push([map(event.t), event.data]);
}
output.sort((a, b) => a[0] - b[0]);
// An empty last frame makes the player's duration include the final hold.
output.push([anchors.at(-1)[1], ""]);
const cast = [JSON.stringify({ version: 2, width: meta.term.cols, height: meta.term.rows, timestamp: meta.timestamp }),
  ...output.map(([time, data]) => JSON.stringify([Number(time.toFixed(4)), "o", data]))].join("\n");
await writeFile(path.join(pages, "terminal.cast"), `${cast}\n`);

const lapseStart = map(runStart);
const lapseEnd = map(done + 0.6);
await writeFile(path.join(pages, "terminal.html"), `<!doctype html><meta charset="utf-8"><title>codex</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/asciinema-player@3.8.2/dist/bundle/asciinema-player.css">
<style>
  @font-face { font-family: "Instrument Sans"; src: url("instrument-sans.woff2") format("woff2"); font-weight: 400 700; }
  html, body { height: 100%; margin: 0; background: #17171b; overflow: hidden; }
  .bar { position: relative; display: flex; align-items: center; height: 46px; padding: 0 18px; background: #222227; border-bottom: 1px solid #2e2e35; font: 500 15px "Instrument Sans", "Helvetica Neue", sans-serif; color: #9a9aa4; }
  .bar i { width: 13px; height: 13px; margin-right: 8px; border-radius: 50%; background: #4a4a52; }
  .bar i:nth-child(1) { background: #ff5f57; } .bar i:nth-child(2) { background: #febc2e; } .bar i:nth-child(3) { background: #28c840; }
  .bar span { position: absolute; left: 0; right: 0; text-align: center; pointer-events: none; }
  .lapse { position: absolute; right: 18px; display: flex; gap: 10px; align-items: baseline; color: #d9d9e0; opacity: 0; transition: opacity .3s; font-variant-numeric: tabular-nums; }
  .lapse.on { opacity: 1; }
  .lapse b { font: 600 17px "JetBrainsMono Nerd Font", Menlo, monospace; }
  .lapse small { color: #8c8c96; font-size: 13px; }
  #term { height: calc(100% - 47px); padding: 10px 14px 0; box-sizing: border-box; }
  .ap-wrapper, .ap-player { background: #17171b !important; }
  .asciinema-player-theme-demo { --term-color-foreground: #e4e4ea; --term-color-background: #17171b;
    --term-color-0: #2b2b31; --term-color-1: #ff6b6b; --term-color-2: #7bd88f; --term-color-3: #f9cc6c; --term-color-4: #78a9ff; --term-color-5: #c792ea; --term-color-6: #5ad4e6; --term-color-7: #d6d6dc;
    --term-color-8: #55555e; --term-color-9: #ff8787; --term-color-10: #9be3a8; --term-color-11: #ffd98a; --term-color-12: #9cc0ff; --term-color-13: #d7a8f0; --term-color-14: #7fe1ee; --term-color-15: #ffffff; }
  .ap-terminal { font-family: "JetBrainsMono Nerd Font", Menlo, monospace !important; }
</style>
<div class="bar"><i></i><i></i><i></i><span>codex — ~/wardrobe-demo/wardrobe</span><div class="lapse"><small>time-lapse</small><b>0:00</b></div></div>
<div id="term"></div>
<script src="https://cdn.jsdelivr.net/npm/asciinema-player@3.8.2/dist/bundle/asciinema-player.min.js"></script>
<script>
  window.castDuration = ${anchors.at(-1)[1].toFixed(3)};
  const anchors = ${JSON.stringify(anchors.map(([real, out]) => [real - runStart, out]))};
  const real = (out) => { for (let i = 1; i < anchors.length; i++) { const [r0, o0] = anchors[i - 1], [r1, o1] = anchors[i]; if (out <= o1) return r0 + (out - o0) / (o1 - o0 || 1) * (r1 - r0); } return anchors.at(-1)[0]; };
  window.player = AsciinemaPlayer.create("terminal.cast", document.getElementById("term"), { autoPlay: false, preload: true, controls: false, fit: "both", theme: "demo", terminalFontFamily: '"JetBrainsMono Nerd Font", Menlo, monospace', terminalLineHeight: 1.22 });
  const lapse = document.querySelector(".lapse"), time = lapse.querySelector("b");
  const format = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };
  // The player rejects time queries until the cast loads, so the clock keeps asking.
  (async function tick() { try { const now = await window.player.getCurrentTime(); lapse.classList.toggle("on", now > ${lapseStart.toFixed(3)} - 0.2); time.textContent = format(Math.min(real(now), ${(done - runStart).toFixed(1)})); } catch {} requestAnimationFrame(tick); })();
</script>`);
console.log(`Run took ${((done - runStart) / 60).toFixed(1)} minutes; time-lapse ${lapse.toFixed(1)}s at about ${Math.round((done - runStart) / lapse)}×; total ${anchors.at(-1)[1].toFixed(2)}s`);

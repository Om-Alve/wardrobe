// Drives the app with agent-browser while recording Chrome's own screencast at 60 fps.
// Every pointer move, click and named moment is logged on the same clock as the frames,
// so the edit can draw a cursor and cut to the beat exactly where things happen.
import { execFile } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now() / 1000;
const ease = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

export class Director {
  constructor({ session = "demo", width = 1600, height = 900, scale = 2, out }) {
    Object.assign(this, { session, width, height, scale, out });
    this.cursor = { x: width * 0.62, y: height * 0.58 };
  }

  async ab(...args) {
    const { stdout } = await run("agent-browser", ["--session", this.session, ...args.map(String)], { maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  }

  async setup(url) {
    await this.ab("set", "viewport", this.width, this.height, this.scale);
    await this.ab("open", url);
    await this.ab("wait", "--load", "networkidle");
    await this.tidy();
  }

  async eval(expression) {
    const result = await this.ab("eval", expression);
    try { return JSON.parse(result); } catch { return result; }
  }

  // Center of the first element matching a CSS selector, in viewport pixels.
  async box(selector, { anchor = [0.5, 0.5], nth = 0 } = {}) {
    const box = await this.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.getClientRects().length)[${nth}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    if (!box) throw new Error(`No element for ${selector}`);
    return { x: box.x + box.w * anchor[0], y: box.y + box.h * anchor[1], box };
  }

  // Finds a button, link or summary by its visible text.
  async byText(text, { within = "body", tags = "button, a, summary, label, [role=tab], [role=radio]", nth = 0 } = {}) {
    const box = await this.eval(`(() => { const want = ${JSON.stringify(text)}.toLowerCase(); const els = [...document.querySelector(${JSON.stringify(within)}).querySelectorAll(${JSON.stringify(tags)})].filter((e) => e.getClientRects().length && (e.innerText || e.getAttribute("aria-label") || "").trim().toLowerCase().startsWith(want)); const el = els[${nth}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    if (!box) throw new Error(`No element with text ${text}`);
    return { x: box.x + box.w / 2, y: box.y + box.h / 2, box };
  }

  cursorKind(x, y) {
    return this.eval(`(() => { const el = document.elementFromPoint(${x}, ${y}); if (!el) return "arrow"; const c = getComputedStyle(el).cursor; return c === "pointer" ? "hand" : c === "text" || (c === "auto" && el.closest("input:not([type=checkbox]):not([type=radio]), textarea")) ? "text" : "arrow"; })()`);
  }

  log(event) { this.events?.push({ ...event, at: now() }); }
  mark(name) { this.log({ type: "mark", name }); }

  // Glides the drawn cursor to a point; the real pointer lands there at the end, so hover styles match.
  async moveTo(target, { duration = 0.55, kind } = {}) {
    const { x, y } = target;
    const from = { ...this.cursor };
    const start = now();
    const steps = Math.max(2, Math.round(duration * 60));
    for (let i = 1; i <= steps; i += 1) {
      const p = ease(i / steps);
      this.events?.push({ type: "move", at: start + (duration * i) / steps, x: from.x + (x - from.x) * p, y: from.y + (y - from.y) * p, kind: this.cursorKindNow || "arrow" });
    }
    await sleep(duration * 1000);
    await this.ab("mouse", "move", Math.round(x), Math.round(y));
    this.cursor = { x, y };
    this.cursorKindNow = kind || await this.cursorKind(x, y);
    this.log({ type: "move", x, y, kind: this.cursorKindNow });
  }

  async click(target, options = {}) {
    await this.moveTo(target, options);
    await sleep(options.settle ?? 120);
    this.log({ type: "down" });
    await this.ab("mouse", "down");
    await sleep(70);
    await this.ab("mouse", "up");
    this.log({ type: "up" });
    if (options.mark) this.mark(options.mark);
    await sleep(options.after ?? 250);
  }

  // Types into the focused field in small bursts, which reads as quick human typing.
  async type(text, { burst = 2, pause = 40 } = {}) {
    for (let i = 0; i < text.length; i += burst) {
      await this.ab("keyboard", "type", text.slice(i, i + burst));
      if (pause) await sleep(pause);
    }
  }

  // Eased scroll of the window, or of a scrolling container when one is named.
  async scrollBy(dy, { duration = 0.9, container = null } = {}) {
    const target = container ? `document.querySelector(${JSON.stringify(container)})` : "document.scrollingElement";
    await this.eval(`new Promise((done) => { const el = ${target}; const y0 = el.scrollTop, t0 = performance.now(), d = ${duration * 1000}; const e = (t) => t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2; const step = (t) => { const p = Math.min(1, (t - t0) / d); el.scrollTop = y0 + ${dy} * e(p); p < 1 ? requestAnimationFrame(step) : done(1); }; requestAnimationFrame(step); })`);
  }

  async scrollIntoView(selector, { block = "center", duration = 0.9, container = null, nth = 0, offset = 90 } = {}) {
    const top = await this.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.getClientRects().length)[${nth}]; if (!el) return null; const r = el.getBoundingClientRect(); const box = ${container ? `document.querySelector(${JSON.stringify(container)}).getBoundingClientRect()` : "{ top: 0, height: innerHeight }"}; return ${JSON.stringify(block)} === "start" ? r.top - box.top - ${offset} : r.top + r.height / 2 - (box.top + box.height / 2); })()`);
    if (top === null) throw new Error(`No element for ${selector}`);
    if (Math.abs(top) > 4) await this.scrollBy(top, { duration, container });
  }

  // Recording-only polish: scrollbars hidden.
  async tidy() {
    await this.eval(`(() => { if (document.getElementById("demo-tidy")) return 1; const style = document.createElement("style"); style.id = "demo-tidy"; style.textContent = "html { scrollbar-width: none } ::-webkit-scrollbar { display: none }"; document.head.appendChild(style); return 1; })()`);
  }

  async waitFor(expression, { timeout = 180000, interval = 250 } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.eval(`(async () => Boolean(await (${expression})))()`) === true) return;
      await sleep(interval);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  }

  pause(seconds) { return sleep(seconds * 1000); }

  async startRecording(name, { cursor = true } = {}) {
    const dir = path.join(this.out, name);
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.join(dir, "frames"), { recursive: true });
    const cdp = await this.ab("get", "cdp-url");
    const http = cdp.replace(/^ws/, "http").replace(/\/devtools\/browser\/.*/, "");
    const pages = (await (await fetch(`${http}/json/list`)).json()).filter((target) => target.type === "page");
    const page = pages.find((target) => !target.url.startsWith("devtools")) || pages[0];
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
    let id = 0;
    const send = (method, params = {}) => socket.send(JSON.stringify({ id: ++id, method, params }));
    const frames = [];
    const writes = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method !== "Page.screencastFrame") return;
      send("Page.screencastFrameAck", { sessionId: message.params.sessionId });
      const file = path.join(dir, "frames", `${String(frames.length).padStart(6, "0")}.jpg`);
      frames.push({ file, at: message.params.metadata.timestamp });
      writes.push(writeFile(file, Buffer.from(message.params.data, "base64")));
    });
    send("Page.startScreencast", { format: "jpeg", quality: 94, everyNthFrame: 1, maxWidth: this.width * this.scale, maxHeight: this.height * this.scale });
    // A one-pixel nudge guarantees a first frame even on a still page.
    send("Runtime.evaluate", { expression: "document.documentElement.style.outline = '1px solid transparent'; requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.style.outline = ''))" });
    this.recording = { name, dir, socket, send, frames, writes, startedAt: now() };
    this.events = [];
    if (cursor) this.log({ type: "move", ...this.cursor, kind: this.cursorKindNow || "arrow" });
    await sleep(300);
  }

  async stopRecording({ tail = 0.6 } = {}) {
    await sleep(tail * 1000);
    const { name, dir, socket, send, frames, writes } = this.recording;
    const stoppedAt = now();
    send("Page.stopScreencast");
    await sleep(200);
    socket.close();
    await Promise.all(writes);
    if (!frames.length) throw new Error(`No frames recorded for ${name}`);
    const origin = frames[0].at;
    // Chrome sends frames only when the page changes, so each 60 fps slot shows the latest frame at that moment.
    const sequence = path.join(dir, "sequence");
    await mkdir(sequence, { recursive: true });
    const total = Math.ceil((stoppedAt - origin) * 60);
    let current = 0;
    for (let slot = 0; slot < total; slot += 1) {
      while (current + 1 < frames.length && frames[current + 1].at - origin <= slot / 60) current += 1;
      await symlink(frames[current].file, path.join(sequence, `${String(slot).padStart(6, "0")}.jpg`));
    }
    const video = path.join(dir, "display.mp4");
    await run("ffmpeg", ["-v", "error", "-y", "-framerate", "60", "-i", path.join(sequence, "%06d.jpg"),
      "-vf", "scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
      "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-movflags", "+faststart", video], { maxBuffer: 16 * 1024 * 1024 });
    const events = this.events.map(({ at, ...event }) => ({ ...event, t: at - origin })).filter((event) => event.t >= -0.5);
    const result = { name, video, duration: stoppedAt - origin, width: this.width, height: this.height, events, marks: Object.fromEntries(events.filter((event) => event.type === "mark").map((event) => [event.name, event.t])) };
    await writeFile(path.join(dir, "timeline.json"), JSON.stringify(result, null, 2));
    await rm(sequence, { recursive: true, force: true });
    await rm(path.join(dir, "frames"), { recursive: true, force: true });
    this.recording = null;
    this.events = null;
    return result;
  }
}

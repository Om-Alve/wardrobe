#!/usr/bin/env node
// Joins the independent grader's blind grades with the hidden keys and the run results, and writes data/bench/report.md.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bench = path.join(fileURLToPath(new URL("../", import.meta.url)), "data", "bench");
const wardrobes = ["yours", "s", "m", "l"].filter((name) => existsSync(path.join(bench, name, "grading", "grades.json")));
const CRITERIA = ["occasion", "weather", "color", "cohesion", "overall"];
const mean = (list) => list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : NaN;
const fixed = (value, digits = 2) => Number.isNaN(value) ? "n/a" : value.toFixed(digits);
const read = async (name, file) => JSON.parse(await readFile(path.join(bench, name, file), "utf8"));

const lines = ["# Wardrobe benchmark", "", "Blind grades from an independent grader (1-5). Random looks are drawn from the same plan-filtered candidates the stylist saw.", ""];
const table = ["| Wardrobe | Pieces | Looks graded | " + CRITERIA.map((criterion) => `${criterion} stylist / random`).join(" | ") + " | Briefs stylist wins | Lookbook picked / other | Picked kept | Reasons accurate | Suggest s (median) | Lookbook s |",
  "|" + " --- |".repeat(11 + CRITERIA.length - 1)];
const flags = [];
for (const name of wardrobes) {
  const key = await read(name, "key.json");
  const grades = await read(name, "grading/grades.json");
  const results = await read(name, "results.json");
  const by = { stylist: [], random: [] };
  let wins = 0;
  let contested = 0;
  for (const [brief, labels] of Object.entries(key.briefs)) {
    const looks = grades.briefs?.[brief]?.looks || {};
    const scored = Object.entries(labels).filter(([label]) => looks[label]).map(([label, source]) => ({ source, ...looks[label] }));
    for (const look of scored) {
      by[look.source]?.push(look);
      for (const flag of look.flags || []) flags.push(`${name} ${brief} (${look.source}): ${flag}`);
    }
    const stylist = mean(scored.filter((look) => look.source === "stylist").map((look) => look.overall));
    const random = mean(scored.filter((look) => look.source === "random").map((look) => look.overall));
    if (!Number.isNaN(stylist) && !Number.isNaN(random)) { contested += 1; if (stylist > random) wins += 1; }
  }
  const book = Object.entries(key.lookbook).filter(([label]) => grades.lookbook?.[label]);
  const picked = book.filter(([, source]) => source === "picked").map(([label]) => grades.lookbook[label]);
  const other = book.filter(([, source]) => source === "other").map(([label]) => grades.lookbook[label]);
  const reasons = grades.reasons || [];
  const seconds = results.briefs.map((brief) => brief.seconds).sort((a, b) => a - b);
  table.push(`| ${name} | ${results.pieces} | ${by.stylist.length + by.random.length} | ${CRITERIA.map((criterion) => `${fixed(mean(by.stylist.map((look) => look[criterion])))} / ${fixed(mean(by.random.map((look) => look[criterion])))}`).join(" | ")} | ${wins} of ${contested} | ${fixed(mean(picked.map((look) => look.overall)))} / ${fixed(mean(other.map((look) => look.overall)))} | ${picked.filter((look) => look.include).length} of ${picked.length} (other ${other.filter((look) => look.include).length} of ${other.length}) | ${reasons.filter((reason) => reason.accurate).length} of ${reasons.length} | ${fixed(seconds[Math.floor(seconds.length / 2)], 1)} | ${fixed(results.lookbook?.seconds ?? NaN, 1)} |`);
  lines.push(`## ${name} (${results.pieces} pieces)`, "", grades.summary || "", "");
  const failed = results.briefs.filter((brief) => brief.status !== 201);
  if (failed.length) lines.push(`Failed briefs: ${failed.map((brief) => `${brief.id} (${brief.error})`).join("; ")}`, "");
  for (const brief of results.briefs) {
    const better = grades.briefs?.[brief.id]?.betterOutfit;
    if (better) lines.push(`- ${brief.id}: grader would have chosen ${better}`);
  }
  lines.push("");
}
const report = [...lines.slice(0, 4), ...table, "", ...lines.slice(4), "## Flags", "", ...flags.map((flag) => `- ${flag}`), ""].join("\n");
await writeFile(path.join(bench, "report.md"), report);
console.log(report);

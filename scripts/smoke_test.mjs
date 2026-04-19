// End-to-end smoke test for the core resolver + output logic.
// Runs the same algorithms as app.js against the real data.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tasks     = JSON.parse(readFileSync(join(root, "data/tasks.json")));
const coords    = JSON.parse(readFileSync(join(root, "data/coords.json")));
const overrides = JSON.parse(readFileSync(join(root, "data/overrides.json")));
const regionCenters = overrides.__regionCenters || {};

const TIER_POINTS = { easy: 10, medium: 30, hard: 80, elite: 200, master: 500 };
const lower = (s) => (s || "").toLowerCase();

function tryEntry(entry, source, leagueRegionLower) {
  if (!entry) return null;
  if (Array.isArray(entry)) {
    const m = entry.find((e) => lower(e.leagueRegion) === leagueRegionLower) || entry[0];
    if (!m || !m.points?.length) return null;
    return { x: m.points[0][0], y: m.points[0][1], plane: m.plane ?? 0, source, label: m.location, approx: false };
  }
  if (entry.locLines?.length) {
    const m = entry.locLines.find((l) => lower(l.leagueRegion) === leagueRegionLower) || entry.locLines[0];
    if (m?.points?.length) return { x: m.points[0][0], y: m.points[0][1], plane: m.plane ?? 0, source, label: m.location, approx: false };
  }
  if (entry.maps?.length) {
    const m = entry.maps[0];
    return { x: m.x, y: m.y, plane: m.plane ?? 0, source: source + "-map", label: m.name || "", approx: true };
  }
  return null;
}

function resolveCoord(task) {
  const rl = lower(task.region);
  for (const link of task.links || []) {
    const r = tryEntry(overrides[link], "override", rl);
    if (r) return r;
  }
  for (const link of task.links || []) {
    const r = tryEntry(coords[link], "wiki-loc", rl);
    if (r) return r;
  }
  const ro = overrides[task.region];
  if (ro) { const r = tryEntry(ro, "override", rl); if (r) return r; }
  const rc = regionCenters[task.region];
  if (rc) return { x: rc.x, y: rc.y, plane: rc.plane ?? 0, source: "region", label: rc.label, approx: true };
  return null;
}

// Scenario: user has Varlamore + Asgarnia + Kourend + Karamja. General always on.
const USER_REGIONS = new Set(["General", "Varlamore", "Asgarnia", "Kourend", "Karamja"]);
const USER_SKILLS = {
  attack: 75, strength: 80, defence: 72, hitpoints: 82, ranged: 75, prayer: 52,
  magic: 70, cooking: 65, woodcutting: 71, fletching: 58, fishing: 60, firemaking: 71,
  crafting: 52, smithing: 55, mining: 62, herblore: 42, agility: 55, thieving: 60,
  slayer: 58, farming: 32, runecraft: 40, hunter: 62, construction: 38
};

const eligible = tasks.filter((t) =>
  t.id != null && USER_REGIONS.has(t.region) &&
  (t.skills || []).every((s) => (USER_SKILLS[lower(s.skill)] || 1) >= s.level)
);

// Sample resolve for the user's earlier wishlist (spot-check)
const sampleNames = [
  "Enter the Taverley Dungeon",
  "Defeat a Black Demon in Asgarnia",
  "Cook 50 Tuna",
  "Enter the Farming Guild",
  "Use the Falador Party room",
  "Defeat the Giant Mole",
  "Catch a Karambwanji",
  "Activate Statue of Ates",
  "Catch 50 Implings in Puro-Puro",
  "Mine 50 Volcanic Sulphur",
];

let hits = 0, approx = 0, misses = 0;
const lines = [];
for (const t of eligible) {
  const c = resolveCoord(t);
  if (!c) { misses++; continue; }
  if (c.approx) approx++;
  else hits++;
}

console.log("Eligible tasks for the user scenario:", eligible.length);
console.log("  exact coord:", hits);
console.log("  approx (region-level):", approx);
console.log("  unresolved:", misses);
console.log();
console.log("Spot checks:");
for (const name of sampleNames) {
  const t = tasks.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.name.toLowerCase().includes(name.toLowerCase()));
  if (!t) { console.log(`  [NOT FOUND] ${name}`); continue; }
  const c = resolveCoord(t);
  console.log(`  ${t.id.toString().padEnd(6)} ${t.name.padEnd(44)} → ${c ? `(${c.x},${c.y},p${c.plane}) [${c.source}] ${c.approx ? "~" : ""}${c.label}` : "UNRESOLVED"}`);
}

// Report top 20 most-common region-fallback tasks (biggest coord gaps)
const fallbackCounts = {};
for (const t of eligible) {
  const c = resolveCoord(t);
  if (c && c.source === "region") {
    // key by first link or name
    const key = t.links[0] || t.name;
    fallbackCounts[key] = (fallbackCounts[key] || 0) + 1;
  }
}
const top = Object.entries(fallbackCounts).sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log("\nTop region-fallback keys (coord DB gaps worth filling next):");
for (const [k, n] of top) console.log(`  ${n.toString().padStart(3)}  ${k}`);

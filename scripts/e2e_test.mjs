// Full end-to-end: parse progress + select tasks + cluster + build route JSON.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tasks     = JSON.parse(readFileSync(join(root, "data/tasks.json")));
const coords    = JSON.parse(readFileSync(join(root, "data/coords.json")));
const overrides = JSON.parse(readFileSync(join(root, "data/overrides.json")));
const regionCenters = overrides.__regionCenters || {};

const REGIONS = [
  { key: "General" }, { key: "Varlamore" }, { key: "Karamja" },
  { key: "Asgarnia" }, { key: "Kourend" }, { key: "Desert" },
  { key: "Kandarin" }, { key: "Fremennik" }, { key: "Morytania" },
  { key: "Tirannwn" }, { key: "Wilderness" },
];
const TIER_ORDER = { easy: 0, medium: 1, hard: 2, elite: 3, master: 4 };
const lower = (s) => (s || "").toLowerCase();
const rid = () => Math.random().toString(36).slice(2, 14);

function tryEntry(entry, source, lr) {
  if (!entry) return null;
  if (Array.isArray(entry)) {
    const m = entry.find((e) => lower(e.leagueRegion) === lr) || entry[0];
    if (!m?.points?.length) return null;
    return { x: m.points[0][0], y: m.points[0][1], plane: m.plane ?? 0, source, label: m.location, approx: false };
  }
  if (entry.locLines?.length) {
    const m = entry.locLines.find((l) => lower(l.leagueRegion) === lr) || entry.locLines[0];
    if (m?.points?.length) return { x: m.points[0][0], y: m.points[0][1], plane: m.plane ?? 0, source, label: m.location, approx: false };
  }
  if (entry.maps?.length) {
    const m = entry.maps[0];
    return { x: m.x, y: m.y, plane: m.plane ?? 0, source: source + "-map", label: m.name || "", approx: true };
  }
  return null;
}

function resolve(task) {
  const lr = lower(task.region);
  for (const link of task.links || []) { const r = tryEntry(overrides[link], "override", lr); if (r) return r; }
  for (const link of task.links || []) { const r = tryEntry(coords[link], "wiki-loc", lr); if (r) return r; }
  const rc = regionCenters[task.region];
  if (rc) return { x: rc.x, y: rc.y, plane: rc.plane ?? 0, source: "region", label: rc.label, approx: true };
  return null;
}

// Simulate 4 regions + General + fresh account
const regions = new Set(["General", "Varlamore", "Karamja", "Asgarnia", "Kourend"]);
const tiers = new Set(["easy", "medium", "hard"]);
const chosen = tasks.filter((t) =>
  t.id != null && regions.has(t.region) && tiers.has(t.tier)
);

const withCoords = chosen.map((t) => ({ task: t, coord: resolve(t) })).filter((e) => e.coord);

// group → cluster
const byRegion = new Map();
for (const e of withCoords) {
  const r = e.task.region;
  if (!byRegion.has(r)) byRegion.set(r, new Map());
  const sub = e.coord.label || "(misc)";
  const subMap = byRegion.get(r);
  if (!subMap.has(sub)) subMap.set(sub, []);
  subMap.get(sub).push(e);
}

const sections = [];
for (const region of REGIONS.map((r) => r.key)) {
  const subMap = byRegion.get(region);
  if (!subMap) continue;
  const clusters = Array.from(subMap.entries()).map(([label, items]) => {
    const cx = items.reduce((a, e) => a + e.coord.x, 0) / items.length;
    const cy = items.reduce((a, e) => a + e.coord.y, 0) / items.length;
    items.sort((a, b) =>
      (TIER_ORDER[a.task.tier] - TIER_ORDER[b.task.tier]) || a.task.name.localeCompare(b.task.name)
    );
    return { label, items, cx, cy };
  });
  // nearest neighbour
  const start = regionCenters[region] || { x: 3200, y: 3200 };
  const ordered = [];
  let cur = start;
  const pool = clusters.slice();
  while (pool.length) {
    pool.sort((a, b) => {
      const da = (a.cx - cur.x) ** 2 + (a.cy - cur.y) ** 2;
      const db = (b.cx - cur.x) ** 2 + (b.cy - cur.y) ** 2;
      return da - db;
    });
    const next = pool.shift();
    ordered.push(next);
    cur = { x: next.cx, y: next.cy };
  }
  sections.push({ region, clusters: ordered });
}

const routeSections = sections.map((s) => {
  const items = [];
  items.push({ customItem: { id: rid(), label: `— ${s.region.toUpperCase()} —`, description: `${s.clusters.reduce((a,c)=>a+c.items.length,0)} tasks` } });
  for (const cluster of s.clusters) {
    items.push({
      customItem: { id: rid(), label: `@ ${cluster.label}`, description: `${cluster.items.length} tasks` },
      location: { x: Math.round(cluster.cx), y: Math.round(cluster.cy), plane: 0 },
    });
    for (const e of cluster.items) {
      items.push({ taskId: e.task.id, location: { x: e.coord.x, y: e.coord.y, plane: e.coord.plane } });
    }
  }
  return { id: rid(), name: s.region, items };
});

const route = { id: rid(), name: "E2E test route", taskType: "LEAGUE_6", sections: routeSections };

// Validate shape
console.log("route.name:", route.name);
console.log("route.taskType:", route.taskType);
console.log("sections:", route.sections.length);
console.log("total items:", route.sections.reduce((a, s) => a + s.items.length, 0));
console.log("total taskIds:", route.sections.reduce((a, s) => a + s.items.filter(i => i.taskId != null).length, 0));
console.log("total customItems:", route.sections.reduce((a, s) => a + s.items.filter(i => i.customItem).length, 0));

// Shape assertions
for (const s of route.sections) {
  if (!s.id || !s.name || !Array.isArray(s.items)) throw new Error("section shape broken: " + s.name);
  for (const it of s.items) {
    if (it.taskId != null) {
      if (typeof it.taskId !== "number") throw new Error("taskId not number");
      if (it.location && (typeof it.location.x !== "number" || typeof it.location.y !== "number")) {
        throw new Error("bad location on task " + it.taskId);
      }
    } else if (it.customItem) {
      if (!it.customItem.id || !it.customItem.label) throw new Error("bad customItem");
    } else {
      throw new Error("item has neither taskId nor customItem");
    }
  }
}
console.log("shape validation: OK");

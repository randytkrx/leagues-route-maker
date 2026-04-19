/*
 * Leagues Route Maker - all client-side. No network calls, no storage beyond
 * the browser tab. The static JSON data files are loaded from the same origin.
 */
(() => {
  "use strict";

  const REGIONS = [
    { key: "General",   label: "General",         forced: true,  note: "always on" },
    { key: "Varlamore", label: "Varlamore",       forced: true,  note: "starter region" },
    { key: "Karamja",   label: "Karamja",         forced: true,  note: "auto-unlock @ 80 tasks" },
    { key: "Asgarnia",  label: "Asgarnia" },
    { key: "Kourend",   label: "Kourend & Kebos" },
    { key: "Desert",    label: "Kharidian Desert" },
    { key: "Kandarin",  label: "Kandarin" },
    { key: "Fremennik", label: "Fremennik" },
    { key: "Morytania", label: "Morytania" },
    { key: "Tirannwn",  label: "Tirannwn" },
    { key: "Wilderness", label: "Wilderness" },
  ];

  const TIER_ORDER = { easy: 0, medium: 1, hard: 2, elite: 3, master: 4 };
  const TIER_POINTS = { easy: 10, medium: 30, hard: 80, elite: 200, master: 500 };

  /** state */
  const state = {
    tasks: [],          // loaded from data/tasks.json
    coords: {},         // loaded from data/coords.json
    overrides: {},      // loaded from data/overrides.json
    regionCenters: {},  // overrides.__regionCenters
    completed: new Set(),
    skills: {},         // { cooking: 50, ... } optional
    ready: false,
  };

  /** ---------- utilities ---------- */
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const rid = () => Math.random().toString(36).slice(2, 14);

  const lower = (s) => (s || "").toLowerCase();

  function setStatus(el, text, kind) {
    el.textContent = text || "";
    el.classList.remove("good", "warn", "bad");
    if (kind) el.classList.add(kind);
  }

  /** ---------- data load ---------- */
  async function loadData() {
    const [tasks, coords, overrides] = await Promise.all([
      fetch("./data/tasks.json").then((r) => r.json()),
      fetch("./data/coords.json").then((r) => r.json()),
      fetch("./data/overrides.json").then((r) => r.json()),
    ]);
    state.tasks = tasks;
    state.coords = coords;
    state.overrides = overrides;
    state.regionCenters = overrides.__regionCenters || {};
    state.ready = true;
  }

  /** ---------- progress parsing ---------- */
  /**
   * Accepts several common shapes:
   *   1. Tasks Tracker export: {"tasks": {"14662": {"completed": true, ...}}}
   *   2. WikiSync dump: {"tasks": [{"id": 14662, "completed": true}, ...]}
   *   3. Simple array of IDs: [14662, 14663, ...]
   *   4. RuneLite plugin settings blob: {"completedTaskIds": [...]}
   *   5. Route JSON (ignores — has no completion data)
   * Returns { completed: Set<number>, skills: {skill: level} }
   */
  function parseProgress(raw) {
    const completed = new Set();
    const skills = {};
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error("Not valid JSON. Double-check the paste.");
    }

    const addId = (id) => {
      const n = typeof id === "string" ? parseInt(id, 10) : id;
      if (Number.isFinite(n)) completed.add(n);
    };

    if (Array.isArray(data)) {
      data.forEach((entry) => {
        if (typeof entry === "number") addId(entry);
        else if (entry && (entry.completed === true || entry.status === "FINISHED") && entry.id != null) addId(entry.id);
      });
    } else if (data && typeof data === "object") {
      if (data.tasks && typeof data.tasks === "object" && !Array.isArray(data.tasks)) {
        for (const [k, v] of Object.entries(data.tasks)) {
          if (v === true || v === "FINISHED" || v === "COMPLETED" || v === "COMPLETE") addId(k);
          else if (v && typeof v === "object") {
            // The Tasks Tracker plugin stores `completed` as a unix-ms timestamp:
            // 0 = not done, non-zero = done. `structId` is the canonical task id.
            const doneByTimestamp = typeof v.completed === "number" && v.completed > 0;
            const doneByBool = v.completed === true;
            const doneByStatus = v.status === "FINISHED" || v.status === "COMPLETE";
            if (doneByTimestamp || doneByBool || doneByStatus) {
              addId(v.structId ?? v.id ?? k);
            }
          }
        }
      }
      if (Array.isArray(data.tasks)) {
        data.tasks.forEach((t) => { if (t && (t.completed || t.done || t.status === "FINISHED")) addId(t.id); });
      }
      if (Array.isArray(data.completedTaskIds)) data.completedTaskIds.forEach(addId);
      if (Array.isArray(data.completed)) data.completed.forEach(addId);
      if (data.skills && typeof data.skills === "object") {
        for (const [k, v] of Object.entries(data.skills)) {
          const lvl = typeof v === "object" ? v.level ?? v.virtualLevel : v;
          if (Number.isFinite(lvl)) skills[lower(k)] = lvl;
        }
      }
      if (data.levels && typeof data.levels === "object") {
        for (const [k, v] of Object.entries(data.levels)) {
          if (Number.isFinite(v)) skills[lower(k)] = v;
        }
      }
    }

    return { completed, skills };
  }

  /** ---------- coord resolution ---------- */
  /**
   * For a task, find the best tile coord.
   * Priority:
   *   1. Overrides keyed by any of the task's [[links]], matching leagueRegion
   *   2. Scraped coords (LocLines) matching leagueRegion
   *   3. Scraped coords (Maps) for the link target
   *   4. Override entry for the task region as a whole
   *   5. __regionCenters[region]
   * Returns { x, y, plane, source: 'override'|'wiki-loc'|'wiki-map'|'region', label, approx: bool }
   */
  function resolveCoord(task, selectedRegions) {
    const regionKey = task.region;                 // e.g. "Varlamore"
    const leagueRegionLower = lower(regionKey);    // "varlamore"

    const tryEntry = (entry, source) => {
      if (!entry) return null;
      // overrides use array-of-LocLine shape directly
      if (Array.isArray(entry)) {
        const matchingRegion = entry.find((e) => lower(e.leagueRegion) === leagueRegionLower) || entry[0];
        if (!matchingRegion) return null;
        const pts = matchingRegion.points || [];
        if (!pts.length) return null;
        return {
          x: pts[0][0],
          y: pts[0][1],
          plane: matchingRegion.plane ?? 0,
          source,
          label: matchingRegion.location,
          approx: false,
        };
      }
      // coords.json entries: { locLines: [], maps: [], ... }
      if (entry.locLines && entry.locLines.length) {
        const byRegion = entry.locLines.find((l) => lower(l.leagueRegion) === leagueRegionLower)
                       || entry.locLines[0];
        if (byRegion && byRegion.points && byRegion.points.length) {
          return {
            x: byRegion.points[0][0],
            y: byRegion.points[0][1],
            plane: byRegion.plane ?? 0,
            source,
            label: byRegion.location,
            approx: false,
          };
        }
      }
      if (entry.maps && entry.maps.length) {
        const m = entry.maps[0];
        return { x: m.x, y: m.y, plane: m.plane ?? 0, source: source + "-map", label: m.name || "", approx: true };
      }
      return null;
    };

    // Pass 1: any override matching any link — overrides always beat wiki data
    for (const link of task.links || []) {
      const r = tryEntry(state.overrides[link], "override");
      if (r) return r;
    }

    // Pass 2: any wiki-scraped coord matching any link
    for (const link of task.links || []) {
      const r = tryEntry(state.coords[link], "wiki-loc");
      if (r) return r;
    }

    // Pass 3: override keyed by region
    const regionOverride = state.overrides[regionKey];
    if (regionOverride) {
      const r = tryEntry(regionOverride, "override");
      if (r) return r;
    }

    // Pass 4: region center fallback
    const rc = state.regionCenters[regionKey];
    if (rc) {
      return { x: rc.x, y: rc.y, plane: rc.plane ?? 0, source: "region", label: rc.label || regionKey, approx: true };
    }
    return null;
  }

  /** ---------- filtering ---------- */
  function skillsOk(task, skills, respectLevels) {
    if (!respectLevels || !task.skills || task.skills.length === 0) return true;
    if (!skills || Object.keys(skills).length === 0) return true;
    return task.skills.every((req) => (skills[lower(req.skill)] || 1) >= req.level);
  }

  function selectTasks(opts) {
    const selectedRegions = new Set(opts.regions);
    const tiers = new Set(opts.tiers);
    return state.tasks.filter((t) => {
      if (!t.id) return false;
      if (!selectedRegions.has(t.region)) return false;
      if (!tiers.has(t.tier)) return false;
      if (opts.completed.has(t.id)) return false;
      if (opts.pactOnly && !t.pactTask) return false;
      if (!skillsOk(t, opts.skills, opts.respectLevels)) return false;
      return true;
    });
  }

  /** ---------- clustering & ordering ---------- */
  /**
   * Group tasks by region, then by sub-location label (the LocLine `location`
   * string we resolved). Within a cluster, sort by tier then name.
   * Across clusters, sort by cluster centroid to reduce travel distance.
   */
  function clusterTasks(tasks, selectedRegions) {
    const withCoords = tasks.map((t) => ({ task: t, coord: resolveCoord(t, selectedRegions) }));

    const skip = [];
    const kept = [];
    for (const entry of withCoords) {
      if (!entry.coord) skip.push(entry);
      else kept.push(entry);
    }

    // group by region → sub-label
    const byRegion = new Map();
    for (const e of kept) {
      const r = e.task.region;
      if (!byRegion.has(r)) byRegion.set(r, new Map());
      const subMap = byRegion.get(r);
      const sub = e.coord.label || "(misc)";
      if (!subMap.has(sub)) subMap.set(sub, []);
      subMap.get(sub).push(e);
    }

    // order regions: General, then user-selected in REGIONS order
    const orderedRegions = REGIONS.map((r) => r.key).filter((k) => byRegion.has(k));
    const sections = [];
    for (const region of orderedRegions) {
      const subMap = byRegion.get(region);
      // inside a region: nearest-neighbour by centroid starting at region centre
      const start = state.regionCenters[region] || { x: 3200, y: 3200 };
      const clusters = Array.from(subMap.entries()).map(([label, items]) => {
        const cx = items.reduce((a, e) => a + e.coord.x, 0) / items.length;
        const cy = items.reduce((a, e) => a + e.coord.y, 0) / items.length;
        return { label, items, cx, cy };
      });
      const ordered = [];
      let cur = start;
      const pool = clusters.slice();
      while (pool.length) {
        pool.sort((a, b) => dist(cur, a) - dist(cur, b));
        const next = pool.shift();
        next.items.sort((a, b) => {
          const t = (TIER_ORDER[a.task.tier] ?? 9) - (TIER_ORDER[b.task.tier] ?? 9);
          return t !== 0 ? t : a.task.name.localeCompare(b.task.name);
        });
        ordered.push(next);
        cur = { x: next.cx, y: next.cy };
      }
      sections.push({ region, clusters: ordered });
    }

    return { sections, skipped: skip };
  }

  function dist(a, b) {
    const dx = a.x - (b.cx ?? b.x);
    const dy = a.y - (b.cy ?? b.y);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** ---------- output ---------- */
  function buildRouteJSON(result, name) {
    const sections = [];
    for (const s of result.sections) {
      const region = REGIONS.find((r) => r.key === s.region);
      const regionLabel = region ? region.label : s.region;

      const items = [];
      // Region header as a customItem so the user sees visual grouping
      items.push({
        customItem: {
          id: rid(),
          label: `— ${regionLabel.toUpperCase()} —`,
          description: `${s.clusters.reduce((a, c) => a + c.items.length, 0)} tasks across ${s.clusters.length} sub-areas`,
        },
      });
      for (const cluster of s.clusters) {
        items.push({
          customItem: {
            id: rid(),
            label: `@ ${cluster.label}`,
            description: `${cluster.items.length} task${cluster.items.length === 1 ? "" : "s"} in this sub-area`,
          },
          location: { x: Math.round(cluster.cx), y: Math.round(cluster.cy), plane: 0 },
        });
        for (const e of cluster.items) {
          const note = [];
          if (e.coord.approx) note.push("APPROX coord");
          if (e.task.skills && e.task.skills.length) {
            note.push(e.task.skills.map((s) => `${s.skill} ${s.level}`).join(", "));
          }
          if (e.task.other) note.push(e.task.other);
          const entry = {
            taskId: e.task.id,
            location: { x: e.coord.x, y: e.coord.y, plane: e.coord.plane },
          };
          if (note.length) entry.note = note.join(" · ");
          items.push(entry);
        }
      }
      sections.push({ id: rid(), name: regionLabel, items });
    }

    if (result.skipped.length) {
      sections.push({
        id: rid(),
        name: "Unresolved (no coord found)",
        items: result.skipped.map((e) => ({ taskId: e.task.id, note: "no coord in wiki data" })),
      });
    }

    return {
      id: rid(),
      name,
      taskType: "LEAGUE_6",
      sections,
    };
  }

  /** ---------- UI wiring ---------- */
  function renderRegions() {
    const grid = $("#regionGrid");
    grid.innerHTML = "";
    for (const r of REGIONS) {
      const id = "reg_" + r.key;
      const wrap = document.createElement("label");
      if (r.forced) wrap.classList.add("forced");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = id;
      cb.value = r.key;
      cb.checked = !!r.forced;
      cb.disabled = !!r.forced;
      cb.dataset.region = r.key;
      const span = document.createElement("span");
      span.textContent = r.label + (r.note ? ` (${r.note})` : "");
      wrap.appendChild(cb);
      wrap.appendChild(span);
      grid.appendChild(wrap);
    }
  }

  function selectedRegions() {
    return $$("#regionGrid input[type=checkbox]")
      .filter((cb) => cb.checked)
      .map((cb) => cb.dataset.region);
  }
  function selectedTiers() {
    return $$("#step-filter .filter-row input[type=checkbox][value]")
      .filter((cb) => cb.checked)
      .map((cb) => cb.value);
  }

  function onLoadProgress() {
    const raw = $("#progressInput").value.trim();
    const status = $("#progressStatus");
    if (!raw) {
      state.completed = new Set();
      state.skills = {};
      setStatus(status, "cleared", "warn");
      return;
    }
    try {
      const { completed, skills } = parseProgress(raw);
      state.completed = completed;
      state.skills = skills;
      const skillCount = Object.keys(skills).length;
      const skillBit = skillCount
        ? ` · ${skillCount} skill levels detected`
        : " · no skill levels in this export — 'respect skill requirements' will have no effect";
      setStatus(
        status,
        `loaded ${completed.size} completed task${completed.size === 1 ? "" : "s"}${skillBit}`,
        completed.size > 0 ? "good" : "warn"
      );
    } catch (err) {
      setStatus(status, err.message, "bad");
    }
  }

  function onClearProgress() {
    $("#progressInput").value = "";
    state.completed = new Set();
    state.skills = {};
    setStatus($("#progressStatus"), "", null);
  }

  function onGenerate() {
    const status = $("#generateStatus");
    if (!state.ready) {
      setStatus(status, "data still loading…", "warn");
      return;
    }
    const regions = selectedRegions();
    const tiers = selectedTiers();
    if (regions.length === 0 || tiers.length === 0) {
      setStatus(status, "pick at least one region and one tier", "warn");
      return;
    }
    const pactOnly = $("#pactOnly").checked;
    const skipNoCoords = $("#skipNoCoords").checked;
    const respectLevels = $("#respectLevels").checked;

    const chosenTasks = selectTasks({
      regions, tiers, pactOnly, respectLevels,
      completed: state.completed,
      skills: state.skills,
    });

    const clustered = clusterTasks(chosenTasks, new Set(regions));
    if (skipNoCoords) clustered.skipped = [];  // drop unresolved from output
    const route = buildRouteJSON(clustered, $("#routeName").value.trim() || "Leagues route");
    const json = JSON.stringify(route, null, 2);
    $("#output").value = json;

    // summary
    const total = chosenTasks.length;
    const resolved = clustered.sections.reduce((a, s) => a + s.clusters.reduce((b, c) => b + c.items.length, 0), 0);
    const approx = clustered.sections.reduce(
      (a, s) => a + s.clusters.reduce((b, c) => b + c.items.filter((e) => e.coord.approx).length, 0), 0
    );
    const points = chosenTasks.reduce((a, t) => a + (TIER_POINTS[t.tier] || 0), 0);

    const sum = $("#summary");
    sum.innerHTML = "";
    const card = (n, lbl) => {
      const d = document.createElement("div"); d.className = "card";
      d.innerHTML = `<div class="n">${n}</div><div class="lbl">${lbl}</div>`;
      return d;
    };
    sum.appendChild(card(total, "tasks selected"));
    sum.appendChild(card(resolved, "with coords"));
    sum.appendChild(card(approx, "approx coords"));
    sum.appendChild(card(clustered.skipped.length, "unresolved"));
    sum.appendChild(card(points.toLocaleString(), "potential points"));
    sum.appendChild(card(clustered.sections.length, "regions in route"));

    setStatus(status, `route built with ${resolved} task${resolved === 1 ? "" : "s"}`, "good");
  }

  async function onCopy() {
    const ta = $("#output");
    if (!ta.value) return;
    try {
      await navigator.clipboard.writeText(ta.value);
      flash($("#copyBtn"), "copied ✓");
    } catch (e) {
      ta.select();
      document.execCommand("copy");
      flash($("#copyBtn"), "copied ✓");
    }
  }

  function onDownload() {
    const text = $("#output").value;
    if (!text) return;
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = ($("#routeName").value || "route").replace(/[^a-z0-9-_]+/gi, "_");
    a.href = url; a.download = safe + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function flash(btn, text) {
    const orig = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = orig; }, 1200);
  }

  /** ---------- boot ---------- */
  function boot() {
    renderRegions();
    $("#loadProgressBtn").addEventListener("click", onLoadProgress);
    $("#clearProgressBtn").addEventListener("click", onClearProgress);
    $("#generateBtn").addEventListener("click", onGenerate);
    $("#copyBtn").addEventListener("click", onCopy);
    $("#downloadBtn").addEventListener("click", onDownload);

    loadData()
      .then(() => setStatus($("#generateStatus"), `ready · ${state.tasks.length} tasks loaded`, "good"))
      .catch((err) => setStatus($("#generateStatus"), "failed to load data: " + err.message, "bad"));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

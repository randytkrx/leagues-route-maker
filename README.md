# Leagues Route Maker

Static web app that generates a [Tasks Tracker plugin](https://runelite.net/plugin-hub/show/tasks-tracker) route for **OSRS Leagues 6: Demonic Pacts**. Pick your regions, paste your progress export, hit generate, copy the JSON back into RuneLite.

Everything runs in the browser. No backend, no API, no analytics, no cookies.

## What it does

1. Loads the full 1,587-task Leagues 6 database (scraped once from the OSRS Wiki).
2. Parses your Tasks Tracker plugin export to skip completed tasks and optionally respect your current skill levels.
3. Resolves each remaining task to a tile coordinate — exact when the wiki has one, region-center as a fallback.
4. Clusters tasks by region → sub-area so the plugin's waypoint arrow walks you through a logical route.
5. Exports `LEAGUE_6` JSON ready to import into the plugin.

## Use it

Deployed version: *fill in your GitHub Pages URL after pushing*.

Local: just open `index.html` — no build step, no server needed.

## Privacy

- **No network calls** after the initial page + data-file load. Tracker JSON you paste stays in your tab and is never sent anywhere.
- No cookies, no localStorage, no analytics, no third-party scripts.
- CI/CD and GitHub Pages don't need any secrets — the repo is entirely static.

If you inspect network tab while the page is open, you should only see `tasks.json`, `coords.json`, `overrides.json`, `app.js`, `style.css`, and `index.html` loaded from your own origin, then nothing.

## Repo layout

```
index.html            ·  landing page
style.css             ·  styling
app.js                ·  all client-side logic
data/tasks.json       ·  1587 tasks (scraped from wiki)
data/coords.json      ·  wiki-scraped tile coords for 1442 entities
data/overrides.json   ·  manual coord overrides + region centers
data/tasks.wiki       ·  raw wikitext (source of truth for rebuilding tasks.json)
scripts/parse_tasks.py  ·  wikitext → tasks.json
scripts/scrape_coords.py · bulk-scrape LocLine/Map coords from wiki
scripts/smoke_test.mjs  ·  end-to-end sanity check
```

## Rebuilding the data

If the wiki updates mid-league:

```bash
curl -sS "https://oldschool.runescape.wiki/w/Demonic_Pacts_League/Tasks?action=raw" > data/tasks.wiki
python3 scripts/parse_tasks.py          # wikitext -> tasks.json (ids = wiki sortId)
python3 scripts/remap_ids.py            # remap to plugin dbRowId so auto-tracking works
python3 scripts/scrape_coords.py        # ~1 min, batches 50 pages at a time
node scripts/smoke_test.mjs              # quick sanity
```

**Why remap?** The wiki's `{{DPLTaskRow|id=N}}` numbers are just sortIds (0-1591). The Tasks Tracker plugin expects the in-game struct ID (`dbRowId`, 6807-15403) to match and auto-tick tasks as you complete them. The plugin publishes the full mapping at `osrs-reldo/task-json-store/tasks/LEAGUE_6.min.json` — `remap_ids.py` pulls that and patches `tasks.json`.

## Improving coords

`data/overrides.json` is the place to add/correct coordinates. Keys are exact wiki page titles. The schema matches LocLine:

```json
"Name of NPC or Object": [
  { "leagueRegion": "varlamore", "location": "human-readable sub-area",
    "points": [[x, y]], "plane": 0 }
]
```

Overrides beat wiki-scraped data. Use them when:
- The wiki has no coord for an entity.
- The wiki coord is for the wrong region (e.g. an NPC that spawns in multiple leagues regions).
- You want the route to aim at a specific spawn tile instead of the wiki map marker.

## License

Task names and descriptions are derived from the [OSRS Wiki](https://oldschool.runescape.wiki) under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/). The code in this repo is MIT. Not affiliated with Jagex.

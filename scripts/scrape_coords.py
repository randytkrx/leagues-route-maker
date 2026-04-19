#!/usr/bin/env python3
"""Bulk-scrape coords for every unique wiki-link referenced by tasks.

Uses MediaWiki's query API in batches of 50 titles. For each page we
pull the raw wikitext and extract:
  - {{LocLine ...}} entries: yield {location, plane, mapID, leagueRegion,
    points: [[x,y], ...]}
  - {{Map ...}} templates: yield {x, y, plane (default 0), mapID (default 0)}
  - Infobox NPC/Item/Scenery |location= narrative (kept as text)

Output: data/coords.json keyed by canonical page title.
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

LINKS_FILE = Path(__file__).parent.parent / "data" / "unique_links.txt"
OUT_FILE = Path(__file__).parent.parent / "data" / "coords.json"
API = "https://oldschool.runescape.wiki/api.php"
HEADERS = {
    # Polite UA per wiki policy
    "User-Agent": "LeaguesRouteMaker/0.1 (static route planner; personal use)",
}
BATCH = 50
SLEEP = 0.5  # be gentle

XY_RE = re.compile(r"x\s*:\s*(\d+)\s*,\s*y\s*:\s*(\d+)")

def fetch_batch(titles: list[str]) -> dict:
    params = {
        "action": "query",
        "prop": "revisions",
        "rvprop": "content",
        "rvslots": "main",
        "redirects": "1",
        "titles": "|".join(titles),
        "format": "json",
        "formatversion": "2",
    }
    url = f"{API}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())

def find_templates(text: str, name: str) -> list[str]:
    """Balanced {{Name...}} extraction (handles nested braces)."""
    out = []
    lname = name.lower()
    i = 0
    while i < len(text):
        j = text.find("{{", i)
        if j < 0:
            break
        # Accept optional whitespace + case-insensitive template name
        tail = text[j + 2 : j + 2 + len(name) + 5].lstrip().lower()
        if not tail.startswith(lname):
            i = j + 2
            continue
        depth = 1
        k = j + 2
        while k < len(text) and depth > 0:
            if text[k : k + 2] == "{{":
                depth += 1
                k += 2
            elif text[k : k + 2] == "}}":
                depth -= 1
                k += 2
            else:
                k += 1
        if depth == 0:
            out.append(text[j:k])
            i = k
        else:
            i = j + 2
    return out

def parse_template_args(tpl: str) -> dict:
    """Split |key=value args from a {{Name|...}} template, top level only."""
    inner = tpl[2:-2]
    first_bar = inner.find("|")
    if first_bar < 0:
        return {}
    body = inner[first_bar + 1 :]
    args: dict[str, str] = {}
    depth_c = depth_s = 0
    cur = []
    key = None

    def flush(key, val):
        val = val.strip()
        if key is None:
            return
        args[key.strip().lower()] = val

    i = 0
    while i < len(body):
        c = body[i]
        nxt = body[i + 1] if i + 1 < len(body) else ""
        if c == "{" and nxt == "{":
            depth_c += 1
            cur.append("{{")
            i += 2
            continue
        if c == "}" and nxt == "}":
            depth_c -= 1
            cur.append("}}")
            i += 2
            continue
        if c == "[" and nxt == "[":
            depth_s += 1
            cur.append("[[")
            i += 2
            continue
        if c == "]" and nxt == "]":
            depth_s -= 1
            cur.append("]]")
            i += 2
            continue
        if c == "|" and depth_c == 0 and depth_s == 0:
            s = "".join(cur)
            if "=" in s and key is None:
                k, _, v = s.partition("=")
                args[k.strip().lower()] = v.strip()
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    s = "".join(cur)
    if "=" in s:
        k, _, v = s.partition("=")
        args[k.strip().lower()] = v.strip()
    return args

def extract_coords(content: str) -> dict:
    locations = []
    for loc_tpl in find_templates(content, "LocLine"):
        args = parse_template_args(loc_tpl)
        points = []
        # x/y is often in a single value like "x:3094,y:3849|x:3110,y:3854"
        # but our parser treats it as one arg value because of the spacing.
        # Handle both the raw template chunk and args.
        xy_source = loc_tpl + " " + " ".join(args.values())
        for m in XY_RE.finditer(xy_source):
            pt = [int(m.group(1)), int(m.group(2))]
            if pt not in points:
                points.append(pt)
        if not points:
            continue
        locations.append({
            "location": re.sub(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", r"\1", args.get("location", "")).strip(),
            "plane": int(args.get("plane", "0") or 0),
            "mapID": int(args.get("mapid", "0") or 0),
            "leagueRegion": args.get("leagueregion", "").strip(),
            "levels": args.get("levels", "").strip(),
            "members": args.get("members", "").strip(),
            "points": points,
        })

    maps = []
    for m_tpl in find_templates(content, "Map"):
        args = parse_template_args(m_tpl)
        try:
            x = int(args.get("x", ""))
            y = int(args.get("y", ""))
        except ValueError:
            continue
        maps.append({
            "x": x,
            "y": y,
            "plane": int(args.get("plane", "0") or 0),
            "mapID": int(args.get("mapid", "0") or 0),
            "name": args.get("name", "").strip(),
        })

    # Infobox location narrative (for human fallback)
    loc_text = None
    infobox_match = re.search(r"\|\s*location\s*=\s*([^\n|]+)", content, re.IGNORECASE)
    if infobox_match:
        loc_text = re.sub(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]", r"\1", infobox_match.group(1)).strip()

    return {
        "locLines": locations,
        "maps": maps,
        "infoboxLocation": loc_text,
    }

def main() -> int:
    if not LINKS_FILE.exists():
        print("run parse_tasks.py first", file=sys.stderr)
        return 1

    titles: list[str] = []
    with LINKS_FILE.open() as f:
        for line in f:
            parts = line.strip().split("\t", 1)
            if len(parts) != 2:
                continue
            titles.append(parts[1])

    existing = {}
    if OUT_FILE.exists():
        existing = json.loads(OUT_FILE.read_text())

    remaining = [t for t in titles if t not in existing]
    print(f"total: {len(titles)}  cached: {len(existing)}  to fetch: {len(remaining)}")

    results = dict(existing)
    redirects: dict[str, str] = {}
    for i in range(0, len(remaining), BATCH):
        batch = remaining[i : i + BATCH]
        try:
            data = fetch_batch(batch)
        except Exception as e:
            print(f"batch {i} failed: {e}", file=sys.stderr)
            time.sleep(2)
            continue

        query = data.get("query", {})
        for r in query.get("redirects", []):
            redirects[r["from"]] = r["to"]
        for r in query.get("normalized", []):
            redirects[r["from"]] = r["to"]

        pages = {p["title"]: p for p in query.get("pages", [])}
        for original in batch:
            resolved = redirects.get(original, original)
            page = pages.get(resolved) or pages.get(original)
            if not page or page.get("missing"):
                results[original] = {"missing": True}
                continue
            revs = page.get("revisions", [])
            if not revs:
                results[original] = {"missing": True}
                continue
            content = revs[0]["slots"]["main"]["content"]
            extracted = extract_coords(content)
            extracted["resolvedTitle"] = page["title"]
            results[original] = extracted

        # Periodic flush so we don't lose progress on interrupt
        if (i // BATCH) % 5 == 0:
            OUT_FILE.write_text(json.dumps(results, separators=(",", ":")))
        print(f"  batch {i // BATCH + 1}/{(len(remaining) + BATCH - 1) // BATCH} ({i + len(batch)}/{len(remaining)})")
        time.sleep(SLEEP)

    OUT_FILE.write_text(json.dumps(results, separators=(",", ":")))
    hits = sum(
        1
        for v in results.values()
        if isinstance(v, dict) and (v.get("locLines") or v.get("maps"))
    )
    print(f"done. {hits}/{len(results)} have at least one coord")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

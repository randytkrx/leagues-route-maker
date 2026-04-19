#!/usr/bin/env python3
"""
Augment tasks.json with derived fields:
  - questReqs: list of quest IDs this task's text references
  - completionPercent: % of players with this task done (from plugin manifest)
  - points: standard tier points
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent.parent
TASKS_FILE = ROOT / "data" / "tasks.json"
QUESTS_FILE = ROOT / "data" / "quests.json"
MANIFEST_URL = (
    "https://raw.githubusercontent.com/osrs-reldo/task-json-store/"
    "refs/heads/main/tasks/LEAGUE_6.min.json"
)
TIER_POINTS = {"easy": 10, "medium": 30, "hard": 80, "elite": 200, "master": 500}

def build_quest_matcher(quests: dict) -> list[tuple[re.Pattern, str]]:
    """Build a list of (regex, questId) pairs for word-boundary matching.
    Longer names first so 'Recipe for Disaster/Another Cook's Quest' beats 'Recipe for Disaster'."""
    items = [(qid, name) for qid, name in quests.items() if not qid.startswith("_")]
    items.sort(key=lambda x: -len(x[1]))
    out = []
    for qid, name in items:
        # \b doesn't play well with apostrophes; use lookaround for whitespace or ends
        pat = re.compile(
            r"(?<![A-Za-z])" + re.escape(name) + r"(?![A-Za-z])",
            re.IGNORECASE,
        )
        out.append((pat, qid, name))
    return out

def main() -> int:
    tasks = json.loads(TASKS_FILE.read_text())
    quests = json.loads(QUESTS_FILE.read_text())
    matchers = build_quest_matcher(quests)

    print(f"fetching plugin manifest...")
    manifest = json.loads(urllib.request.urlopen(MANIFEST_URL, timeout=30).read())
    pct_by_db = {m["dbRowId"]: m.get("completionPercent") for m in manifest}

    quest_hits = 0
    pct_hits = 0
    for t in tasks:
        # --- quest requirements ---
        text = (t.get("other") or "") + " " + " ".join(t.get("links") or []) + " " + (t.get("description") or "")
        found_qids = []
        consumed_spans = []   # prevent "The Frozen Door" and "Frozen Door" both matching
        for pat, qid, name in matchers:
            for m in pat.finditer(text):
                span = (m.start(), m.end())
                if any(span[0] >= cs[0] and span[1] <= cs[1] for cs in consumed_spans):
                    continue
                consumed_spans.append(span)
                if qid not in found_qids:
                    found_qids.append(qid)
        if found_qids:
            t["questReqs"] = found_qids
            quest_hits += 1

        # --- completion percent ---
        pct = pct_by_db.get(t.get("id"))
        if pct is not None:
            t["completionPercent"] = pct
            pct_hits += 1

        # --- points ---
        t["points"] = TIER_POINTS.get(t.get("tier"), 0)

    TASKS_FILE.write_text(json.dumps(tasks, indent=2))
    print(f"tasks with questReqs: {quest_hits}/{len(tasks)}")
    print(f"tasks with completionPercent: {pct_hits}/{len(tasks)}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

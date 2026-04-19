#!/usr/bin/env python3
"""
Map wiki ids -> plugin struct ids (dbRowId).

The Tasks Tracker plugin uses `dbRowId` (in-game cache struct ID, range 6807-15403)
as the `taskId` in imported routes. The OSRS Wiki uses its own sequential
task IDs (0-1591) in the {{DPLTaskRow|id=N}} template -- those match the
plugin's `sortId`, not its `dbRowId`.

This script pulls the plugin's LEAGUE_6.min.json and rewrites data/tasks.json
so `id` is the plugin's dbRowId. Without this, the plugin can't auto-tick
tasks as you complete them in-game because taskId never matches.
"""
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent.parent
TASKS_FILE = ROOT / "data" / "tasks.json"
MANIFEST_URL = (
    "https://raw.githubusercontent.com/osrs-reldo/task-json-store/"
    "refs/heads/main/tasks/LEAGUE_6.min.json"
)

def main() -> int:
    print(f"fetching plugin manifest from {MANIFEST_URL} ...")
    with urllib.request.urlopen(MANIFEST_URL, timeout=30) as r:
        manifest = json.loads(r.read())
    print(f"  {len(manifest)} entries, dbRowId range "
          f"{min(m['dbRowId'] for m in manifest)}-{max(m['dbRowId'] for m in manifest)}")

    sort_to_db = {m["sortId"]: m["dbRowId"] for m in manifest}

    tasks = json.loads(TASKS_FILE.read_text())
    remapped = 0
    skipped = 0
    for t in tasks:
        sort_id = t.get("id")
        if sort_id is None or sort_id not in sort_to_db:
            skipped += 1
            continue
        # Preserve the old wiki id for debugging / future rebuilds
        t["sortId"] = sort_id
        t["id"] = sort_to_db[sort_id]
        remapped += 1

    TASKS_FILE.write_text(json.dumps(tasks, indent=2))
    print(f"remapped {remapped} tasks, skipped {skipped}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

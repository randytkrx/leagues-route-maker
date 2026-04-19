#!/usr/bin/env python3
"""
Upgrade an existing Tasks Tracker route JSON: match each customItem's
`label` against the real task database and, where we find a clear match,
replace it with a proper {taskId, location, note} entry so auto-tracking
works. Non-task items (banks, buy-stops, region teleports) stay as
customItems since they don't correspond to real game tasks.

Usage:
  python3 scripts/upgrade_route.py <input.json> [output.json]
"""
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).parent.parent
TASKS_FILE = ROOT / "data" / "tasks.json"

# Phrases in labels we can safely strip before matching
STRIP_PATTERNS = [
    r"\([^)]*?(easy|medium|hard|elite|master|demonic pact|pact)[^)]*\)",  # (EASY 10pts), (Hard 80pts)
    r"\([^)]*?\d+\s*(attack|strength|defence|hitpoints|ranged|prayer|magic|runecraft|construction|agility|herblore|thieving|crafting|fletching|slayer|hunter|mining|smithing|fishing|cooking|firemaking|woodcutting|farming|att|str|def|hp|mag|rng|rc|agi|herb|thieve|craft|fletch|hunt|mine|smith|fish|cook|fm|wc|farm)[^)]*\)",  # (24 Craft ✓)
    r"\([^)]*?\d+\s*pts[^)]*\)",                                          # (80pts)
    r"\([^)]*?(pact|relic)[^)]*\)",
    r"[✓✗]+",                                                             # checkmarks
    r"\bpts?\b",
    r"- continue\s*$",
    r"- chain\s*$",
    r"—.*$",
]

NON_TASK_PREFIXES = [
    "bank ", "bank:", "bank-", "start:", "buy ", "buy:", "buy items",
    "region teleport", "teleport to", "fairy ring", "quetzal to",
    "pick up", "drop items", "empty bucket", "pickup", "fly to",
    "run to", "travel to", "equip your", "withdraw",
    "train ", "chop an oak tree", "get level", "soften clay",
]

def normalise(s: str) -> str:
    s = s.lower()
    for pat in STRIP_PATTERNS:
        s = re.sub(pat, " ", s, flags=re.IGNORECASE)
    s = re.sub(r"[^\w\s']+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

def is_non_task(label: str) -> bool:
    low = label.lower().strip()
    return any(low.startswith(p) for p in NON_TASK_PREFIXES)

def tokenise(s: str) -> set:
    words = normalise(s).split()
    return {w for w in words if len(w) > 2 and w not in {
        "the", "and", "for", "from", "with", "any", "some", "your", "you",
        "one", "each", "near", "then", "per", "via",
    }}

MANUAL_ALIASES = {
    # label substring -> task id
    "dark cave near hunter guild": 14622,   # Enter a dark cave in Varlamore
    "enter a dark cave": 14622,
}

def match_task(label: str, tasks: list[dict]) -> tuple[dict, float]:
    """Return (best-matching task, score) or (None, 0) if nothing good."""
    if is_non_task(label):
        return None, 0

    low = label.lower()
    for needle, tid in MANUAL_ALIASES.items():
        if needle in low:
            hit = next((t for t in tasks if t.get("id") == tid), None)
            if hit:
                return hit, 1.0
    target_norm = normalise(label)
    target_toks = tokenise(label)
    if not target_toks:
        return None, 0

    best_task = None
    best_score = 0
    for t in tasks:
        name = t.get("name") or ""
        name_norm = normalise(name)
        name_toks = tokenise(name)
        if not name_toks:
            continue

        # Token Jaccard
        jaccard = len(target_toks & name_toks) / len(target_toks | name_toks)

        # String similarity on cleaned forms
        ratio = SequenceMatcher(None, target_norm, name_norm).ratio()

        # Prefer tasks whose normalised name is a substring of the label or vice versa
        bonus = 0
        if name_norm and (name_norm in target_norm or target_norm in name_norm):
            bonus = 0.2

        # Require numeric quantities to match when present
        num_target = re.search(r"\b(\d+)\b", target_norm)
        num_name = re.search(r"\b(\d+)\b", name_norm)
        if num_target and num_name and num_target.group(1) != num_name.group(1):
            ratio *= 0.3  # penalise mismatched counts
            jaccard *= 0.3

        # Bump the score if numeric quantities match AND at least 2 key tokens overlap
        if num_target and num_name and num_target.group(1) == num_name.group(1):
            overlap = len(target_toks & name_toks)
            if overlap >= 2:
                bonus += 0.15

        # If every significant token from the task name appears in the target
        # label, that's a strong "label contains the task name" signal —
        # handles "Enter Dark Cave near Hunter Guild" ← "Enter a dark cave..."
        if name_toks and name_toks.issubset(target_toks) and len(name_toks) >= 3:
            bonus += 0.25

        score = 0.55 * jaccard + 0.35 * ratio + bonus
        if score > best_score:
            best_score, best_task = score, t

    # Accept matches above 0.5 — anything below is flagged as low-confidence
    # in the caller so the user can sanity-check it.
    return (best_task, best_score) if best_score >= 0.5 else (None, best_score)

def main() -> int:
    if len(sys.argv) < 2:
        print("usage: upgrade_route.py <input.json> [output.json]", file=sys.stderr)
        return 2

    in_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else in_path.with_suffix(".upgraded.json")
    tasks = json.loads(TASKS_FILE.read_text())

    route = json.loads(in_path.read_text())

    converted = 0
    kept_custom = 0
    non_task = 0
    ambiguous = []

    for section in route.get("sections", []):
        new_items = []
        for item in section.get("items", []):
            if "taskId" in item:
                new_items.append(item)
                continue
            ci = item.get("customItem")
            if not ci:
                new_items.append(item)
                continue
            label = ci.get("label", "")
            if is_non_task(label):
                new_items.append(item)
                non_task += 1
                continue
            best, score = match_task(label, tasks)
            if best and best.get("id") is not None:
                entry = {"taskId": best["id"]}
                if "location" in item:
                    entry["location"] = item["location"]
                # Keep the original description as a note — helps the in-game runner
                bits = []
                if ci.get("description"):
                    bits.append(ci["description"])
                if score < 0.75:
                    bits.append(f"[auto-match score {score:.2f} — verify]")
                    ambiguous.append((label, best["name"], score))
                if bits:
                    entry["note"] = " · ".join(bits)
                new_items.append(entry)
                converted += 1
            else:
                new_items.append(item)
                kept_custom += 1
        section["items"] = new_items

    out_path.write_text(json.dumps(route, indent=2))
    print(f"converted to taskId : {converted}")
    print(f"kept as customItem  : {kept_custom}  (no confident match)")
    print(f"kept as waypoint    : {non_task}     (banks/teleports/buy-stops)")
    if ambiguous:
        print(f"\n⚠ {len(ambiguous)} matches under 0.75 confidence — spot-check these:")
        for lbl, name, score in ambiguous:
            print(f"   [{score:.2f}] '{lbl[:60]}' → '{name}'")
    print(f"\nwrote {out_path}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

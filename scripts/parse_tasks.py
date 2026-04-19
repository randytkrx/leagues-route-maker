#!/usr/bin/env python3
"""Parse raw Demonic Pacts League/Tasks wikitext into data/tasks.json."""
import json
import re
import sys
from pathlib import Path

WIKI_FILE = Path(__file__).parent.parent / "data" / "tasks.wiki"
OUT_FILE = Path(__file__).parent.parent / "data" / "tasks.json"

ROW_RE = re.compile(r"^\{\{DPLTaskRow\|(.+)\}\}$")

def split_template_args(body: str) -> list[str]:
    """Split on | but respect nested {{...}} and [[...]]."""
    out, depth_curly, depth_sq, cur = [], 0, 0, []
    i = 0
    while i < len(body):
        c = body[i]
        if c == "{" and i + 1 < len(body) and body[i + 1] == "{":
            depth_curly += 1; cur.append("{{"); i += 2; continue
        if c == "}" and i + 1 < len(body) and body[i + 1] == "}":
            depth_curly -= 1; cur.append("}}"); i += 2; continue
        if c == "[" and i + 1 < len(body) and body[i + 1] == "[":
            depth_sq += 1; cur.append("[["); i += 2; continue
        if c == "]" and i + 1 < len(body) and body[i + 1] == "]":
            depth_sq -= 1; cur.append("]]"); i += 2; continue
        if c == "|" and depth_curly == 0 and depth_sq == 0:
            out.append("".join(cur)); cur = []; i += 1; continue
        cur.append(c); i += 1
    out.append("".join(cur))
    return out

LINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")
SCP_RE = re.compile(r"\{\{SCP\|([^|}]+)\|(\d+)(?:\|[^}]*)?\}\}")
TEMPLATE_RE = re.compile(r"\{\{[^}]*\}\}")

def strip_wiki_markup(s: str) -> str:
    if not s:
        return ""
    s = LINK_RE.sub(lambda m: (m.group(2) or m.group(1)).strip(), s)
    s = TEMPLATE_RE.sub("", s)
    s = re.sub(r"'{2,}", "", s)
    return s.strip()

def extract_skills(s_param: str) -> list[dict]:
    """Return [{skill, level}] from e.g. '{{SCP|Magic|9|link=yes}}'."""
    return [
        {"skill": m.group(1), "level": int(m.group(2))}
        for m in SCP_RE.finditer(s_param or "")
    ]

def extract_links(text: str) -> list[str]:
    """Return canonical target names from [[...]] links (for coord resolution later)."""
    return [m.group(1).strip() for m in LINK_RE.finditer(text or "")]

def main() -> int:
    if not WIKI_FILE.exists():
        print(f"missing: {WIKI_FILE}", file=sys.stderr)
        return 1

    tasks: list[dict] = []
    with WIKI_FILE.open() as f:
        for line in f:
            line = line.strip()
            m = ROW_RE.match(line)
            if not m:
                continue
            args = split_template_args(m.group(1))
            if len(args) < 2:
                continue

            name = strip_wiki_markup(args[0])
            desc_raw = args[1]
            desc = strip_wiki_markup(desc_raw)

            kv: dict[str, str] = {}
            for a in args[2:]:
                if "=" in a:
                    k, _, v = a.partition("=")
                    kv[k.strip()] = v.strip()

            tasks.append({
                "id": int(kv["id"]) if kv.get("id", "").isdigit() else None,
                "name": name,
                "description": desc,
                "tier": kv.get("tier", "").lower(),
                "region": kv.get("region", ""),
                "skills": extract_skills(kv.get("s", "")),
                "other": strip_wiki_markup(kv.get("other", "")),
                "pactTask": kv.get("pactTask", "").lower() == "yes",
                "links": extract_links(desc_raw),
            })

    tasks.sort(key=lambda t: (t["region"], t["tier"], t["id"] or 0))
    OUT_FILE.write_text(json.dumps(tasks, indent=2))
    print(f"wrote {len(tasks)} tasks to {OUT_FILE}")

    regions: dict[str, int] = {}
    tiers: dict[str, int] = {}
    for t in tasks:
        regions[t["region"]] = regions.get(t["region"], 0) + 1
        tiers[t["tier"]] = tiers.get(t["tier"], 0) + 1
    print("regions:", regions)
    print("tiers:", tiers)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

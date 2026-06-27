#!/usr/bin/env python3
"""OKF v0.1 conformance check. No deps. Usage: python3 validate.py [bundle_dir]

Rules (SPEC.md): every non-reserved .md has parseable YAML frontmatter with a
non-empty `type`; reserved files index.md/log.md exist. Broken links, unknown
types, and missing optional fields are tolerated by spec — reported as warnings.
"""
import sys, re, pathlib

RESERVED = {"index.md", "log.md"}
root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
errors, warnings = [], []

def frontmatter(text):
    # ponytail: regex over the --- block, not a YAML parser — frontmatter here is flat key: value
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return None
    fields = {}
    for line in m.group(1).splitlines():
        km = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if km:
            fields[km.group(1)] = km.group(2).strip()
    return fields

mds = sorted(root.glob("*.md"))
names = {p.name for p in mds}
for r in RESERVED:
    if r not in names:
        errors.append(f"missing reserved file: {r}")

for p in mds:
    if p.name in RESERVED:
        continue
    fm = frontmatter(p.read_text())
    if fm is None:
        errors.append(f"{p.name}: no parseable frontmatter block")
        continue
    if not fm.get("type"):
        errors.append(f"{p.name}: missing/empty required `type`")

# warn-only: bundle-relative links that don't resolve
for p in mds:
    for link in re.findall(r"\]\((/[^)\s]+\.md)\)", p.read_text()):
        if not (root / link.lstrip("/")).exists():
            warnings.append(f"{p.name}: broken link {link}")

for w in warnings:
    print(f"warn: {w}")
if errors:
    for e in errors:
        print(f"FAIL: {e}")
    sys.exit(1)
print(f"OK: {len(mds)} files, OKF v0.1 conformant")

#!/usr/bin/env python3
"""Structural audit: compare OLD (AnistrimBackend2) vs NEW (AnistrimBackend)"""

import os
import sys

OLD_ROOT = r"C:\Users\benar\Desktop\AnistrimBackend2"
NEW_ROOT = r"C:\Users\benar\Desktop\AnistrimBackend"

EXCLUDE_DIRS = {'node_modules', '.git', '__pycache__', '.gradle'}

def walk_rel(root):
    result = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune excluded dirs
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, '/')
        if rel_dir == '.':
            rel_dir = ''
        for f in filenames:
            if rel_dir:
                result.append(f"{rel_dir}/{f}")
            else:
                result.append(f)
    return sorted(result)


print("Walking OLD project...")
old_files = walk_rel(OLD_ROOT)
print(f"OLD file count: {len(old_files)}")

print("Walking NEW project...")
new_files = walk_rel(NEW_ROOT)
print(f"NEW file count: {len(new_files)}")

# Normalize paths (already using /)
old_set = set(old_files)
new_set = set(new_files)

missing = sorted(old_set - new_set)
new_only = sorted(new_set - old_set)
common = sorted(old_set & new_set)

# Save results
out_dir = r"C:\Users\benar\Desktop\AnistrimBackend"

with open(os.path.join(out_dir, "audit_summary.txt"), "w") as f:
    f.write(f"OLD FILE COUNT: {len(old_files)}\n")
    f.write(f"NEW FILE COUNT: {len(new_files)}\n\n")
    f.write(f"========= MISSING FROM NEW ({len(missing)}) =========\n")
    for m in missing:
        f.write(f"  {m}\n")
    f.write(f"\n========= NEW-ONLY FILES ({len(new_only)}) =========\n")
    for n in new_only:
        f.write(f"  {n}\n")
    f.write(f"\n========= COMMON FILES ({len(common)}) =========\n")
    for c in common:
        f.write(f"  {c}\n")

# Also write just the counts summary
with open(os.path.join(out_dir, "audit_counts.txt"), "w") as f:
    f.write(f"OLD_FILE_COUNT={len(old_files)}\n")
    f.write(f"NEW_FILE_COUNT={len(new_files)}\n")
    f.write(f"MISSING_COUNT={len(missing)}\n")
    f.write(f"NEW_ONLY_COUNT={len(new_only)}\n")
    f.write(f"COMMON_COUNT={len(common)}\n")

print(f"\nDone! Missing: {len(missing)}, New-only: {len(new_only)}, Common: {len(common)}")
print("Results written to audit_summary.txt and audit_counts.txt")
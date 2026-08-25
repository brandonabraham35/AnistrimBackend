#!/usr/bin/env python3
"""Independent structural comparison of OLD vs NEW ui.js"""

OLD = r"C:\Users\benar\Desktop\AnistrimBackend2\Web\js\ui.js"
NEW = r"C:\Users\benar\Desktop\AnistrimBackend\Web\js\ui.js"

with open(OLD, 'r', encoding='utf-8') as f:
    old_lines = f.readlines()
with open(NEW, 'r', encoding='utf-8') as f:
    new_lines = f.readlines()

print(f"OLD ui.js: {len(old_lines)} lines")
print(f"NEW ui.js: {len(new_lines)} lines")

# Find key structural elements and their line numbers (0-indexed)
def find_keyword(lines, keyword):
    results = []
    for i, line in enumerate(lines):
        if keyword in line:
            results.append((i+1, line.rstrip()))  # 1-indexed
    return results

print("\n=== KEY STRUCTURAL ELEMENTS ===")

for label, kw in [
    ("async function loadHome", "async function loadHome"),
    ("loadHome opening brace", "function loadHome"),
    ("try block", "try {"),
    ("catch block", "} catch (e)"),
    ("loadRanking call", "loadRanking(s)"),
    ("var rankData", "var rankData"),
    ("function loadRanking", "function loadRanking"),
    ("function renderRankItems", "function renderRankItems"),
    ("function switchRankTab", "function switchRankTab"),
    ("window.AniStrimUI", "window.AniStrimUI"),
    ("switchRankTab export", "switchRankTab: switchRankTab"),
    ("window.AniStrimViews", "window.AniStrimViews"),
    ("})(closing IIFE", "})();"),
]:
    old_hits = find_keyword(old_lines, kw)
    new_hits = find_keyword(new_lines, kw)
    print(f"\n{label}:")
    print(f"  OLD: {old_hits}")
    print(f"  NEW: {new_hits}")

# Check what comes after the catch block in both files
print("\n\n=== TRANSITION REGION COMPARISON ===")
print("\nOLD lines around /after catch block:")
for i, line in enumerate(old_lines):
    line_num = i + 1
    if 'catch (e)' in line:
        # Print up to line 10 after
        for j in range(i, min(i+15, len(old_lines))):
            print(f"  {j+1:4d}: {old_lines[j].rstrip()}")
        break

print("\nNEW lines around /after catch block:")
for i, line in enumerate(new_lines):
    line_num = i + 1
    if 'catch (e)' in line:
        for j in range(i, min(i+52, len(new_lines))):
            print(f"  {j+1:4d}: {new_lines[j].rstrip()}")
        break

# Export object comparison
print("\n\n=== WINDOW.ANISTRIMUI EXPORT COMPARISON ===")
print("\nOLD export:")
in_export = False
for i, line in enumerate(old_lines):
    if 'window.AniStrimViews' in line:
        in_export = False
    if in_export:
        print(f"  {i+1:4d}: {line.rstrip()}")
    if 'window.AniStrimUI' in line and '{' in line:
        in_export = True

print("\nNEW export:")
in_export = False
for i, line in enumerate(new_lines):
    if 'window.AniStrimViews' in line:
        in_export = False
    if in_export:
        print(f"  {i+1:4d}: {line.rstrip()}")
    if 'window.AniStrimUI' in line and '{' in line:
        in_export = True

# Check for `rankData` scope by tracking brace depth around it
print("\n\n=== BRACE DEPTH ANALYSIS AROUND rankData ===")
for file_lines, label in [(old_lines, "OLD"), (new_lines, "NEW")]:
    print(f"\n{label}:")
    depth = 0
    recording = False
    for i, line in enumerate(file_lines):
        stripped = line.rstrip()
        depth += stripped.count('{') - stripped.count('}')
        
        if 'var rankData' in line:
            recording = True
            print(f"  Line {i+1} (depth={depth}): {stripped}")
            # Print next 5 lines to see function defs
            for j in range(i, min(i+50, len(file_lines))):
                s = file_lines[j].rstrip()
                d = s.count('{') - s.count('}')
                # Track any scope changes
                print(f"    {j+1:4d} (depth={depth}): {s}")
                depth += d
                if depth < original_depth:
                    break
            break
        original_depth = depth

print("\n\n=== INDEPENDENT DIAGNOSIS ===")
print("Based on the actual OLD and NEW file contents above,")
print("the diagnosis is independently VERIFIED or REFUTED below.")
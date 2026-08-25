#!/usr/bin/env python3
"""Targeted confirmation: transition region and exports"""

OLD = r"C:\Users\benar\Desktop\AnistrimBackend2\Web\js\ui.js"
NEW = r"C:\Users\benar\Desktop\AnistrimBackend\Web\js\ui.js"

with open(OLD, 'r', encoding='utf-8') as f:
    old = f.readlines()
with open(NEW, 'r', encoding='utf-8') as f:
    new = f.readlines()

print("### OLD file: lines 310-325 ###")
for i in range(309, 325):
    print(f"{i+1:4d}: {old[i].rstrip()}")

print("\n### NEW file: lines 310-325 ###")
for i in range(309, 325):
    print(f"{i+1:4d}: {new[i].rstrip()}")

print("\n### OLD file: lines 355-370 ###")
for i in range(354, 370):
    print(f"{i+1:4d}: {old[i].rstrip()}")

print("\n### NEW file: lines 355-370 ###")
for i in range(354, 370):
    print(f"{i+1:4d}: {new[i].rstrip()}")

print("\n### Export object: OLD (lines 1395-1410) ###")
for i in range(1394, 1410):
    print(f"{i+1:4d}: {old[i].rstrip()}")

print("\n### Export object: NEW (lines 1395-1410) ###")
for i in range(1394, 1410):
    print(f"{i+1:4d}: {new[i].rstrip()}")

# Brace depth check: count braces on given lines
print("\n### OLD lines 268-320 - function depth analysis ###")
depth = 0
for i in range(267, 320):
    line = old[i]
    depth += line.count('{') - line.count('}')
    if i == 267 or i == 269 or i == 270 or i == 315 or i == 316 or i == 317 or i == 318 or i == 319:
        print(f"  line {i+1}: depth={depth} | {line.rstrip()}")

print("\n### NEW lines 268-320 - function depth analysis ###")
depth = 0
for i in range(267, 320):
    line = new[i]
    depth += line.count('{') - line.count('}')
    if i == 267 or i == 269 or i == 270 or i == 315 or i == 316 or i == 317 or i == 318 or i == 319:
        print(f"  line {i+1}: depth={depth} | {line.rstrip()}")

# Where does loadHome close in each file?
print("\n### Searching for loadHome close brace (next '}' with '  }' after line 316 in OLD) ###")
def find_loadhome_close(lines, start_idx):
    depth = 0
    for i in range(start_idx, len(lines)):
        line = lines[i]
        depth += line.count('{') - line.count('}')
        # depth returns to 1 means loadHome closed (was at depth 2 inside)
        if depth <= 1 and i > start_idx:
            return i+1
    return None

old_close = find_loadhome_close(old, 316)  # starts after line 316
new_close = find_loadhome_close(new, 316)
print(f"OLD: loadHome closes at line ~{old_close}")
print(f"NEW: loadHome closes at line ~{new_close}")

# Verify what's between catch-close and loadHome-close in both
print("\n### OLD: code between catch end and loadHome close ###")
for i in range(316, min(old_close, 330)):
    print(f"  {i+1:4d}: {old[i].rstrip()}")

print("\n### NEW: code between catch end and loadHome close ###")
for i in range(316, min(new_close, 370)):
    print(f"  {i+1:4d}: {new[i].rstrip()}")
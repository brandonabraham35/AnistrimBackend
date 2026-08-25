#!/usr/bin/env python3
"""Focused structural audit: strip build artifacts, focus on source code"""

import os

OLD_ROOT = r"C:\Users\benar\Desktop\AnistrimBackend2"
NEW_ROOT = r"C:\Users\benar\Desktop\AnistrimBackend"

EXCLUDE_DIRS = {'node_modules', '.git', '__pycache__', '.gradle'}
# Also exclude build/intermediates (android build artifacts)
IGNORE_PREFIXES = [
    'android/app/build/intermediates/',
    'android/capacitor-cordova-android-plugins/build/intermediates/',
    'android/.gradle/',
    'ios/App/App/public/',  # duplicated frontend assets in iOS build
    'ios/capacitor-cordova-ios-plugins/',
]

def is_ignored(path):
    """Check if path should be excluded from the analysis"""
    for prefix in IGNORE_PREFIXES:
        if path.startswith(prefix):
            return True
    return False

def walk_rel(root):
    result = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, '/')
        if rel_dir == '.':
            rel_dir = ''
        for f in filenames:
            rel = f"{rel_dir}/{f}" if rel_dir else f
            if not is_ignored(rel):
                result.append(rel)
    return sorted(result)

print("Walking OLD (source-only)...")
old_files = walk_rel(OLD_ROOT)
print(f"OLD source files: {len(old_files)}")

print("Walking NEW (source-only)...")
new_files = walk_rel(NEW_ROOT)
print(f"NEW source files: {len(new_files)}")

old_set = set(old_files)
new_set = set(new_files)

missing = sorted(old_set - new_set)
new_only = sorted(new_set - old_set)
common = sorted(old_set & new_set)

out_dir = r"C:\Users\benar\Desktop\AnistrimBackend"

with open(os.path.join(out_dir, "focused_audit.txt"), "w") as f:
    f.write(f"OLD source files: {len(old_files)}\n")
    f.write(f"NEW source files: {len(new_files)}\n\n")
    f.write(f"========== MISSING FROM NEW (source files) ==========\n\n")
    for m in missing:
        f.write(f"  {m}\n")
    f.write(f"\n========== NEW-ONLY FILES ==========\n\n")
    for n in new_only:
        f.write(f"  {n}\n")
    f.write(f"\n========== WEB FOLDER FILES ==========\n\n")
    # Web files
    old_web = sorted([x for x in old_files if x.startswith('Web/')])
    new_web = sorted([x for x in new_files if x.startswith('Web/')])
    f.write("OLD Web files:\n")
    for w in old_web:
        status = "PRESENT" if w in new_set else "MISSING"
        f.write(f"  {w} [{status}]\n")
    f.write("\nNEW Web files:\n")
    for w in new_web:
        status = "PRESENT" if w in old_set else "NEW"
        f.write(f"  {w} [{status}]\n")

print(f"\nMissing: {len(missing)}, New-only: {len(new_only)}, Common: {len(common)}")

# Now do the critical-area breakdown
areas = ['Web/', 'Frontend/', 'config/', 'controllers/', 'middleware/', 'routes/', 
         'services/', 'shared/', 'sql/', 'utils/', 'validation/', 'scripts/', 
         'Desktop/', 'AdminDashboard/']

for area in areas:
    area_missing = sorted([m for m in missing if m.startswith(area)])
    area_new_only = sorted([n for n in new_only if n.startswith(area)])
    area_common = sorted([c for c in common if c.startswith(area)])
    
    # Determine source-level files (not build artifacts in subdirs)
    real_source_missing = [m for m in area_missing 
                          if not is_ignored(m)
                          and not '/build/' in m
                          and not '/intermediates/' in m]
    
    if real_source_missing:
        print(f"\n[{area}] MISSING source files: {len(real_source_missing)}")
        for m in real_source_missing:
            print(f"    - {m}")

print("\nDone focused audit.")
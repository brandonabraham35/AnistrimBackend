#!/usr/bin/env python3
"""Final structural audit checks - part 1"""

import os

OLD = r"C:\Users\benar\Desktop\AnistrimBackend2"
NEW = r"C:\Users\benar\Desktop\AnistrimBackend"
EXCLUDE = {'node_modules', '.git', '__pycache__', '.gradle', 'build'}

def files_in(root, subdir):
    path = os.path.join(root, subdir)
    if not os.path.isdir(path): return []
    result = []
    for dirpath, dirnames, filenames in os.walk(path):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE and d != 'intermediates']
        rel = os.path.relpath(dirpath, root).replace(os.sep, '/')
        for f in filenames: result.append(f"{rel}/{f}")
    return sorted(result)

def fexists(root, path): return os.path.isfile(os.path.join(root, path))

sections = {
    'Frontend/': 'Frontend/', 'Desktop/': 'Desktop/', 'AdminDashboard/': 'AdminDashboard/',
    'config/': 'config/', 'controllers/': 'controllers/', 'middleware/': 'middleware/',
    'routes/': 'routes/', 'services/': 'services/', 'shared/': 'shared/', 'sql/': 'sql/',
    'utils/': 'utils/', 'validation/': 'validation/', 'scripts/': 'scripts/',
    'migrations/': 'migrations/', 'test/': 'test/', 'docs/': 'docs/', 'reports/': 'reports/',
    'diagnostics/': 'diagnostics/', 'tmp/': 'tmp/', 'ios/': 'ios/', 'Web/': 'Web/',
}

print("=" * 60)
print("SECTION-BY-SECTION COMPARISON (source files only)")
print("=" * 60)

for label, subdir in sorted(sections.items()):
    old_f = files_in(OLD, subdir)
    new_f = files_in(NEW, subdir)
    old_s = set(old_f); new_s = set(new_f)
    missing = sorted(old_s - new_s)
    new_only = sorted(new_s - old_s)
    real_missing = [f for f in missing if '/build/' not in f and '/intermediates/' not in f and '/.transforms/' not in f]
    if real_missing:
        print(f"\n[{label}] MISSING ({len(real_missing)}):")
        for f in real_missing: print(f"  - {f}")
    if new_only:
        print(f"\n[{label}] NEW ({len(new_only)}):")
        for f in new_only: print(f"  - {f}")
    clean_old = len([f for f in old_f if '/build/' not in f and '/intermediates/' not in f])
    clean_new = len([f for f in new_f if '/build/' not in f and '/intermediates/' not in f])
    if clean_old != clean_new:
        print(f"  (Source count: OLD={clean_old}, NEW={clean_new})")
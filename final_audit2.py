#!/usr/bin/env python3
"""Final structural audit checks - part 2"""

import os

OLD = r"C:\Users\benar\Desktop\AnistrimBackend2"
NEW = r"C:\Users\benar\Desktop\AnistrimBackend"
EXCLUDE = {'node_modules', '.git', '__pycache__', '.gradle', 'build'}

def fexists(root, path): return os.path.isfile(os.path.join(root, path))

def files_in(root, subdir):
    path = os.path.join(root, subdir)
    if not os.path.isdir(path): return []
    result = []
    for dirpath, dirnames, filenames in os.walk(path):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE and d != 'intermediates']
        rel = os.path.relpath(dirpath, root).replace(os.sep, '/')
        for f in filenames: result.append(f"{rel}/{f}")
    return sorted(result)

print("=" * 60)
print("ROOT FILES")
print("=" * 60)
for f in ['package.json', 'package-lock.json', 'server.js', 'capacitor.config.json', '.gitignore', '.env.example', 'README.md']:
    old = fexists(OLD, f); new = fexists(NEW, f)
    print(f"  {f}: OLD={old} NEW={new}")

print("\n" + "=" * 60)
print("VENDOR FILES")
print("=" * 60)
for f in ['Web/js/vendor/hls.min.js', 'Web/js/vendor/shared/session.js']:
    old = fexists(OLD, f); new = fexists(NEW, f)
    if old and new:
        osz = os.path.getsize(os.path.join(OLD, f)); nsz = os.path.getsize(os.path.join(NEW, f))
        print(f"  {f}: ✓ | OLD={osz} NEW={nsz}")
    else: print(f"  {f}: OLD={old} NEW={new}")

print("\n" + "=" * 60)
print("SHARED/CLIENT-CONTRACT")
print("=" * 60)
for f in ['shared/client-contract/app.js', 'shared/client-contract/endpoints.js', 'shared/client-contract/envelope.js', 'shared/client-contract/http.js', 'shared/client-contract/session.js']:
    print(f"  {f}: OLD={fexists(OLD, f)} NEW={fexists(NEW, f)}")

print("\n" + "=" * 60)
print(".env FILE")
print("=" * 60)
print(f"  .env exists in NEW: {fexists(NEW, '.env')} (informational)")

# Case sensitivity
print("\n" + "=" * 60)
print("CASE SENSITIVITY")
print("=" * 60)
old_all = files_in(OLD, ''); new_all = files_in(NEW, '')
old_src = {f.lower(): f for f in old_all if not any(x in f for x in ['/build/', '/intermediates/', '/.transforms/', 'node_modules'])}
new_src = {f.lower(): f for f in new_all if not any(x in f for x in ['/build/', '/intermediates/', '/.transforms/', 'node_modules'])}
issues = []
for low, actual in old_src.items():
    if low in new_src and actual != new_src[low]:
        issues.append(f"  {actual} vs {new_src[low]}")
if issues: [print(c) for c in issues]
else: print("  No case discrepancies in common files")

# Empty/suspicious
print("\n" + "=" * 60)
print("EMPTY/SUSPICIOUS FILES")
print("=" * 60)
susp = []
for f in old_src:
    op = os.path.join(OLD, f); np = os.path.join(NEW, f)
    if os.path.isfile(op) and os.path.isfile(np):
        osz = os.path.getsize(op); nsz = os.path.getsize(np)
        if nsz == 0 and osz > 0: susp.append((f, osz, nsz, "EMPTY in NEW"))
        elif osz > 1000 and nsz < 10: susp.append((f, osz, nsz, "TOO SMALL"))
if susp:
    for f, osz, nsz, reason in susp: print(f"  {f}: OLD={osz} NEW={nsz} [{reason}]")
else: print("  No suspicious files found")

# Duplicates
print("\n" + "=" * 60)
print("DUPLICATE NAMES")
print("=" * 60)
name_map = {}
for dirpath, dirnames, filenames in os.walk(NEW):
    dirnames[:] = [d for d in dirnames if d not in EXCLUDE]
    for f in filenames:
        rel = os.path.relpath(os.path.join(dirpath, f), NEW).replace(os.sep, '/')
        if 'node_modules' not in rel:
            name = os.path.basename(f)
            name_map.setdefault(name, []).append(rel)
dups = {k: v for k, v in name_map.items() if len(v) > 1 and k not in ('package.json', 'package-lock.json', '.env', '.env.example', '.gitignore', '.gitkeep.md')}
if dups:
    for name, paths in sorted(dups.items()):
        print(f"  '{name}' appears {len(paths)} times: {paths}")
else: print("  No duplicate file names found")

print("\n=== FINAL AUDIT CHECK COMPLETE ===")
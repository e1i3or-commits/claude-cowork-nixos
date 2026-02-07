#!/usr/bin/env python3
"""
enable_topbar.py - Patch Claude Desktop's index.js to enable topbar tabs on Linux

Applies 3 critical patches to the minified app bundle:
1. Enable preference defaults for quietPenguin/louderPenguin
2. Bypass QL() production gate that blocks features in packaged builds
3. Force-inject feature support in the mC() async merger

Without these patches, the "Chat | Cowork | Code" topbar tabs won't appear
because the app gates them behind macOS-only checks.

Usage:
    python3 enable_topbar.py /path/to/app/.vite/build/index.js
"""

import re
import sys
import shutil


def patch_file(filepath):
    with open(filepath, 'rb') as f:
        content = f.read()

    original = content
    patches_applied = 0

    # Patch 1: Change preference defaults
    # quietPenguinEnabled:!1 → !0 (false → true)
    # louderPenguinEnabled:!1 → !0 (false → true)
    pattern1 = rb'quietPenguinEnabled:!1,louderPenguinEnabled:!1'
    replace1 = rb'quietPenguinEnabled:!0,louderPenguinEnabled:!0'
    if pattern1 in content:
        content = content.replace(pattern1, replace1)
        patches_applied += 1
        print('[Patch 1] Preference defaults: enabled quietPenguin + louderPenguin')
    else:
        print('[Patch 1] WARNING: Pattern not found (preferences may already be patched)')

    # Patch 2: Bypass QL() production gate
    # The function name (Jhe) may vary per version - use a flexible regex
    # Original: function Xxx(t){return xe.app.isPackaged?{status:"unavailable"}:t()}
    # Patched:  function Xxx(t){return t()}
    pattern2 = rb'function (\w+)\(t\)\{return \w+\.app\.isPackaged\?\{status:"unavailable"\}:t\(\)\}'
    match2 = re.search(pattern2, content)
    if match2:
        func_name = match2.group(1)
        original_func = match2.group(0)
        patched_func = b'function ' + func_name + b'(t){return t()}'
        content = content.replace(original_func, patched_func)
        patches_applied += 1
        print(f'[Patch 2] QL() gate bypass: patched {func_name.decode()}()')
    else:
        print('[Patch 2] WARNING: QL() gate pattern not found')

    # Patch 3: Override features in mC() async merger
    # Append quietPenguin/louderPenguin as supported after desktopVoiceDictation
    pattern3 = rb'(desktopVoiceDictation:await \w+\(\))\}\)'
    replace3 = rb'\1,quietPenguin:{status:"supported"},louderPenguin:{status:"supported"}})'
    result3, count3 = re.subn(pattern3, replace3, content)
    if count3 > 0:
        content = result3
        patches_applied += 1
        print(f'[Patch 3] mC() merger override: injected feature support ({count3} match)')
    else:
        print('[Patch 3] WARNING: mC() merger pattern not found')

    if content != original:
        # Create backup
        backup_path = filepath + '.bak'
        shutil.copy2(filepath, backup_path)
        print(f'\n[Backup] Saved to {backup_path}')

        with open(filepath, 'wb') as f:
            f.write(content)

        print(f'\n[Done] {patches_applied}/3 patches applied successfully')
    else:
        print('\n[Done] No changes needed (already patched or patterns not found)')

    return patches_applied


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(f'Usage: {sys.argv[0]} <path/to/index.js>')
        sys.exit(1)

    filepath = sys.argv[1]
    try:
        count = patch_file(filepath)
        if count < 3:
            print(f'\nWARNING: Only {count}/3 patches applied. App version may have changed.')
            print('Check the patterns against the current index.js and update if needed.')
            sys.exit(1 if count == 0 else 0)
    except FileNotFoundError:
        print(f'Error: File not found: {filepath}')
        sys.exit(1)
    except Exception as e:
        print(f'Error: {e}')
        sys.exit(1)

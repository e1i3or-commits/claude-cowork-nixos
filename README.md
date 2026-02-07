# Claude Cowork for NixOS

Run [Claude Desktop](https://claude.ai/download) with full **Cowork** support (the "Chat | Cowork | Code" topbar tabs) on NixOS Linux.

Claude's Cowork feature lets Claude autonomously use your computer - browsing, coding, and running commands - in a sandboxed environment. This project makes it work on NixOS by replacing macOS-native components with JavaScript equivalents and patching the app to enable the feature flags.

> **Disclaimer**: This is an unofficial community project. It is not affiliated with, endorsed by, or supported by Anthropic. Use at your own risk. Claude Desktop is Anthropic's proprietary software - this project only provides the compatibility layer to run it on Linux.

## Requirements

- **NixOS** (or any Linux with Nix package manager)
- **Nix packages**: `_7zz`, `nodejs`, `electron`, `nodePackages.asar`, `curl`, `python3`
- ~500MB disk space

## Quick Start

```bash
# Clone the repo
git clone https://github.com/e1i3or-commits/claude-cowork-nixos.git
cd claude-cowork-nixos

# Install (downloads Claude Desktop, extracts, patches, installs)
nix-shell -p _7zz nodejs electron nodePackages.asar curl python3 --run "bash install.sh"

# Launch
claude-cowork
```

If you already downloaded the macOS DMG or Windows installer:

```bash
CLAUDE_DMG=/path/to/Claude.dmg nix-shell -p _7zz nodejs electron nodePackages.asar curl python3 --run "bash install.sh"
# or
CLAUDE_EXE=/path/to/Claude-Setup-x64.exe nix-shell -p _7zz nodejs electron nodePackages.asar curl python3 --run "bash install.sh"
```

## What Gets Installed

| Path | Purpose |
|------|---------|
| `~/.local/share/claude-cowork/app/` | Application files |
| `~/.local/bin/claude-cowork` | Launcher (wraps with `nix-shell -p electron nodejs`) |
| `~/.config/Claude/` | User config and data |
| `~/.local/share/applications/claude-cowork.desktop` | Desktop entry |

No sudo required. Everything lives in user-space.

## How It Works

Claude Desktop is built with Electron and uses native (Swift/Objective-C) modules on macOS. On Linux, we:

1. **Platform spoofing** - `process.platform` returns `'darwin'` for app code but the real platform for Electron/Node internals (via stack-trace inspection)
2. **Native module stubs** - JavaScript replacements for `@ant/claude-swift` (VM emulation, clipboard, notifications) and `@ant/claude-native` (window management, auth)
3. **IPC handler interception** - Wraps `ipcMain.handle()` and `webContents.ipc.handle()` to override feature detection and VM status responses
4. **BrowserWindow frame fix** - Converts `titleBarStyle:"hidden"` to `frame:true` on Linux (the hidden style creates an invisible drag region that blocks mouse events)
5. **3 patches to index.js** - Enable the topbar tabs that are gated behind production checks

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical deep-dive.

## Patches Explained

The app's minified `index.js` has three gatekeeping mechanisms that prevent the topbar tabs from appearing. We patch all three:

| # | What | Pattern | Fix |
|---|------|---------|-----|
| 1 | Preference defaults | `quietPenguinEnabled:!1,louderPenguinEnabled:!1` | Change `!1` to `!0` |
| 2 | Production gate (QL) | `function Xxx(t){return xe.app.isPackaged?{status:"unavailable"}:t()}` | Remove the `isPackaged` check |
| 3 | Feature merger (mC) | After `desktopVoiceDictation:await ...()` | Inject `quietPenguin` and `louderPenguin` as `{status:"supported"}` |

These are applied automatically by `patches/enable_topbar.py` during installation.

**Feature codenames**: `quietPenguin` = Cowork tab, `louderPenguin` = Code tab, `chillingSlothFeat` = local agent mode, `yukonSilver` = secure VM, `desktopTopBar` = topbar UI.

## Launcher Options

```bash
claude-cowork              # Normal launch
claude-cowork --debug      # Enable trace logging
claude-cowork --devtools   # Enable Chrome DevTools (for debugging)
```

## Hyprland Window Rules

If you use Hyprland, copy the window rules:

```bash
cp config/hyprland/claude.conf ~/.config/hypr/
echo 'source = ~/.config/hypr/claude.conf' >> ~/.config/hypr/hyprland.conf
```

## Troubleshooting

**App launches but topbar tabs don't appear**
- Check if patches applied: `python3 patches/enable_topbar.py ~/.local/share/claude-cowork/app/Contents/Resources/app/.vite/build/index.js`
- If patterns not found, the app version may have changed. Check the patch patterns against the new index.js.

**White screen / app doesn't load**
- Run with `--debug` flag and check logs in `~/.local/share/claude-cowork/logs/`
- Ensure you're logged in to your Claude account

**Wayland issues**
- The launcher auto-detects Wayland and sets `ELECTRON_OZONE_PLATFORM_HINT=wayland`
- If you have issues, try forcing X11: `ELECTRON_OZONE_PLATFORM_HINT=x11 claude-cowork`

**First launch is slow**
- Normal - `nix-shell` needs to fetch electron on first run
- To speed up, add `electron` and `nodejs` to `environment.systemPackages` in your NixOS config

## Project Structure

```
claude-cowork-nixos/
├── install.sh                          # NixOS installer
├── linux-loader.js                     # Main Electron entry point
├── patches/
│   └── enable_topbar.py                # 3 regex patches for index.js
├── stubs/
│   ├── @ant/
│   │   ├── claude-swift/js/index.js    # VM emulation, clipboard, notifications
│   │   └── claude-native/index.js      # Window management, auth, preferences
│   └── frame-fix/
│       ├── frame-fix-entry.js          # Entry point
│       └── frame-fix-wrapper.js        # Frame fix + secondary compatibility layer
└── config/
    └── hyprland/
        └── claude.conf                 # Window rules for Hyprland WM
```

## Credits

- [johnzfitch/claude-cowork-linux](https://github.com/johnzfitch/claude-cowork-linux) - Original project, stubs, and architecture
- [patrickjaja/claude-desktop-bin](https://github.com/patrickjaja/claude-desktop-bin) - Feature flag documentation and patch patterns
- [aaddrick/claude-desktop-arch](https://github.com/aaddrick/claude-desktop-arch) - Linux packaging reference

## License

MIT - See [LICENSE](LICENSE)

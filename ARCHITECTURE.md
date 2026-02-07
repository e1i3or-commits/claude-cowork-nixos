# Architecture

Technical deep-dive into how Claude Desktop's Cowork feature is made to work on Linux.

## Loading Sequence

```
electron linux-loader.js
    │
    ├── 0. TMPDIR fix (prevent EXDEV cross-device rename errors)
    ├── 0b. fs.rename patch (copy+delete fallback for cross-filesystem moves)
    ├── 1. Platform spoofing (process.platform, os.platform(), etc.)
    ├── 2. Module._load interception (native .node → JS stubs)
    ├── 3. Electron patching (systemPreferences, BrowserWindow, Menu)
    ├── 3b. BrowserWindow Proxy (titlebar fix)
    ├── 3c. Electron module Proxy (intercept BrowserWindow access)
    ├── 4. IPC handler interception (FORCE_OVERRIDES + ERROR_FALLBACKS)
    ├── 5. Per-webContents IPC interception
    ├── 6. Error handling
    │
    └── 7. require('./app/frame-fix-entry.js')
              │
              ├── require('./frame-fix-wrapper.js')
              │     ├── Secondary TMPDIR fix (child processes)
              │     ├── Secondary platform spoofing
              │     ├── Cowork globals
              │     └── Module.prototype.require interception
              │
              └── require('../.vite/build/index.js')  ← the patched app
```

## Platform Spoofing Strategy

Claude Desktop checks `process.platform` extensively. Returning `'darwin'` to app code makes it follow macOS code paths, which our stubs can handle. But Electron itself must see the real platform to function correctly.

**Solution**: `Object.defineProperty` on `process.platform` with a getter that inspects the call stack:

```javascript
Object.defineProperty(process, 'platform', {
  get() {
    const stack = new Error().stack || '';
    const callerFrames = stack.split('\n').slice(2).join('\n');
    if (isSystemCall(callerFrames)) return REAL_PLATFORM;
    return 'darwin';
  }
});
```

`isSystemCall()` returns true for frames from:
- `node:internal`, `internal/modules` (Node.js core)
- `node:electron`, `electron/js2c`, `electron.asar` (Electron internals)
- `linux-loader.js`, `frame-fix-wrapper` (our own code)

The same approach is applied to `process.arch`, `os.platform()`, `os.arch()`, and `process.getSystemVersion()`.

## Native Module Interception

The app loads two native (.node) binaries:
- `swift_addon.node` - Objective-C/Swift bindings for VM control, clipboard, etc.
- `claude-native-binding.node` - Low-level native utilities

Since these are Mach-O binaries, they can't load on Linux. We intercept at `Module._load`:

```javascript
Module._load = function(request, _parent, _isMain) {
  if (request.includes('swift_addon') && request.endsWith('.node'))
    return loadSwiftStub();  // → stubs/@ant/claude-swift/js/index.js
  if (request.includes('claude-native-binding') && request.endsWith('.node'))
    return {};               // → empty object (IPC handlers do the work)
  // ...
};
```

## IPC Architecture

The app uses an internal IPC library called **eipc** (Electron IPC) with channels in the format:

```
$eipc_message$_<UUID>_$_<namespace>_$_<handler>
```

Where UUID changes per app version (e.g., `88f68109-35b3-450a-aa0d-4ba8a8215b14`).

Rather than targeting specific UUIDs, we intercept `ipcMain.handle()` itself and match on the handler name suffix:

```javascript
ipcMain.handle = function(channel, handler) {
  for (const [pattern, override] of Object.entries(FORCE_OVERRIDES)) {
    if (channel.includes(pattern)) return origHandle(channel, override);
  }
  // ...
};
```

### FORCE_OVERRIDES (always replaced)

These handlers are completely replaced because the original implementations call macOS-only APIs:

| Handler | Returns |
|---------|---------|
| `AppFeatures_$_getSupportedFeatures` | Feature flags with Cowork enabled |
| `AppFeatures_$_getCoworkFeatureState` | `{enabled: true, status: 'supported'}` |
| `AppFeatures_$_getYukonSilverStatus` | `{status: 'supported'}` |
| `AppFeatures_$_getFeatureFlags` | `{yukonSilver: true, cowork: true, ...}` |

### ERROR_FALLBACKS (try original, catch errors)

These wrap the original handler and provide a fallback if it throws:

| Handler | Fallback |
|---------|----------|
| `ClaudeVM_$_getRunningStatus` | `{running: true, connected: true}` |
| `ClaudeVM_$_getDownloadStatus` | `{status: 'ready', downloaded: true}` |
| `ClaudeVM_$_start` | `{started: true, status: 'running'}` |
| `ClaudeCode_$_prepare` | `{ready: true, status: 'ready'}` |

### Per-WebContents IPC

The eipc library also registers handlers via `webContents.ipc.handle()` (not just `ipcMain.handle()`). We intercept these too via the `web-contents-created` event.

## BrowserWindow Frame Fix

On macOS, `titleBarStyle: "hidden"` creates a borderless window with custom traffic light buttons. On Linux, the same option creates an invisible drag region (~36px) at the top of the window that intercepts all mouse events, making the topbar unusable.

**Fix**: `electron.BrowserWindow` is a non-configurable getter, so we can't replace it directly. Instead:

1. Create a `Proxy` around `BrowserWindow` that intercepts the constructor
2. Create a `Proxy` around the entire `electron` module that returns our `BrowserWindow` proxy
3. Return the electron proxy from `Module._load` when `'electron'` is requested

```javascript
const BrowserWindowProxy = new Proxy(OrigBrowserWindow, {
  construct(target, args) {
    const options = args[0] || {};
    if (REAL_PLATFORM === 'linux') {
      options.titleBarStyle = 'default';
      options.frame = true;
      delete options.titleBarOverlay;
    }
    return Reflect.construct(target, [options]);
  }
});
```

Quick Entry windows (frameless + transparent) are left untouched.

## TMPDIR / EXDEV Fix

NixOS typically mounts `/tmp` as tmpfs. The app downloads VM bundles to `/tmp` then tries to `rename()` them to `~/.config/Claude/`. Since `rename()` can't cross filesystem boundaries, this fails with `EXDEV`.

**Fix (two-pronged)**:
1. Redirect `TMPDIR` to `~/.config/Claude/vm_bundles/tmp` (same filesystem as target)
2. Patch `fs.rename()` to fall back to copy+delete on `EXDEV`
3. Pre-create fake VM bundle marker files so the download is skipped entirely

## Patch Analysis

### Patch 1: Preference Defaults

```
Before: quietPenguinEnabled:!1,louderPenguinEnabled:!1
After:  quietPenguinEnabled:!0,louderPenguinEnabled:!0
```

The app stores user preferences with defaults. By changing the defaults from `false` to `true`, the features are enabled without requiring user action.

### Patch 2: QL() Production Gate Bypass

```
Before: function Jhe(t){return xe.app.isPackaged?{status:"unavailable"}:t()}
After:  function Jhe(t){return t()}
```

The QL() gate function checks if the app is running as a packaged build. If so, it returns `{status: "unavailable"}` instead of calling the feature detection function. Since we're running a packaged build (extracted from the official installer), we remove this check.

The function name (`Jhe`) may vary between versions - the patch uses a regex to match any function name.

### Patch 3: mC() Feature Merger Override

```
Before: desktopVoiceDictation:await Xxx()})
After:  desktopVoiceDictation:await Xxx(),quietPenguin:{status:"supported"},louderPenguin:{status:"supported"}})
```

The `mC()` function merges feature detection results from multiple sources into a single object. By appending our features at the end, they override any earlier `{status: "unavailable"}` values.

## Security Model

- **No root access required** - Everything installs to `~/.local/`
- **Platform spoofing is local** - Only affects the Claude process, not the system
- **VM stubs report "connected"** - The app thinks its VM is running, but code execution actually happens via Claude Code CLI natively on your system
- **Auth uses system browser** - OAuth redirects to `xdg-open` instead of macOS WebView
- **No network isolation bypass** - The app's network access is unchanged

#!/usr/bin/env node
/**
 * linux-loader.js - Claude Linux compatibility layer
 *
 * Main entry point for running Claude Desktop on Linux.
 * Handles platform spoofing, native module interception,
 * IPC handler overrides, and BrowserWindow frame fixes.
 *
 * CRITICAL ORDER OF OPERATIONS:
 * 0. TMPDIR fix + os.tmpdir() patch (fixes EXDEV cross-device rename)
 * 1. Platform spoofing (immediate - patches process.platform AND os.platform())
 * 2. Module interception (BEFORE electron require!)
 * 3. Electron patching (safe now that interception is active)
 * 4. Load application
 */

// ============================================================
// 0. TMPDIR FIX - MUST BE ABSOLUTELY FIRST
// ============================================================
// Fix EXDEV error: App downloads VM to /tmp (tmpfs) then tries to
// rename() to ~/.config/Claude/ (disk). rename() can't cross filesystems.
const os = require('os');
const path = require('path');
const fs = require('fs');

const vmBundleDir = path.join(os.homedir(), '.config/Claude/vm_bundles');
const vmTmpDir = path.join(vmBundleDir, 'tmp');
const claudeVmBundle = path.join(vmBundleDir, 'claudevm.bundle');

try {
  fs.mkdirSync(vmTmpDir, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = vmTmpDir;
  process.env.TMP = vmTmpDir;
  process.env.TEMP = vmTmpDir;
  os.tmpdir = function() { return vmTmpDir; };

  // Pre-create VM bundle to skip download (we run native, no VM needed)
  fs.mkdirSync(claudeVmBundle, { recursive: true, mode: 0o755 });
  const markers = ['bundle_complete', 'rootfs.img', 'rootfs.img.zst', 'vmlinux', 'config.json'];
  for (const m of markers) {
    const p = path.join(claudeVmBundle, m);
    if (!fs.existsSync(p)) {
      if (m === 'config.json') {
        fs.writeFileSync(p, '{"version":"linux-native","skip_vm":true}', { mode: 0o644 });
      } else {
        fs.writeFileSync(p, 'linux-native-placeholder', { mode: 0o644 });
      }
    }
  }
  fs.writeFileSync(path.join(claudeVmBundle, 'version'), '999.0.0-linux-native', { mode: 0o644 });
  console.log('[TMPDIR] Fixed: ' + vmTmpDir);
} catch (e) {
  console.error('[TMPDIR] Setup failed:', e.message);
}

// ============================================================
// 0b. PATCH fs.rename TO HANDLE EXDEV (cross-device) ERRORS
// ============================================================
const originalRename = fs.rename;
const originalRenameSync = fs.renameSync;

fs.rename = function(oldPath, newPath, callback) {
  originalRename(oldPath, newPath, (err) => {
    if (err && err.code === 'EXDEV') {
      const readStream = fs.createReadStream(oldPath);
      const writeStream = fs.createWriteStream(newPath);
      readStream.on('error', callback);
      writeStream.on('error', callback);
      writeStream.on('close', () => {
        fs.unlink(oldPath, (unlinkErr) => callback(null));
      });
      readStream.pipe(writeStream);
    } else {
      callback(err);
    }
  });
};

fs.renameSync = function(oldPath, newPath) {
  try {
    return originalRenameSync(oldPath, newPath);
  } catch (err) {
    if (err.code === 'EXDEV') {
      fs.copyFileSync(oldPath, newPath);
      fs.unlinkSync(oldPath);
      return;
    }
    throw err;
  }
};

const Module = require('module');

console.log('='.repeat(60));
console.log('Claude Linux Loader');
console.log('='.repeat(60));

const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;
const RESOURCES_DIR = __dirname;
const STUB_PATH = path.join(RESOURCES_DIR, 'stubs', '@ant', 'claude-swift', 'js', 'index.js');

// ============================================================
// 1. PLATFORM/ARCH/VERSION SPOOFING (must be first!)
// ============================================================
// Spoof for app code only - Electron and Node internals need real platform

function isSystemCall(stack) {
  return stack.includes('node:internal') ||
         stack.includes('internal/modules') ||
         stack.includes('node:electron') ||
         stack.includes('electron/js2c') ||
         stack.includes('electron.asar') ||
         stack.includes('linux-loader.js') ||
         stack.includes('frame-fix-wrapper');
}

Object.defineProperty(process, 'platform', {
  get() {
    const stack = new Error().stack || '';
    const callerFrames = stack.split('\n').slice(2).join('\n');
    if (isSystemCall(callerFrames)) return REAL_PLATFORM;
    return 'darwin';
  },
  configurable: true
});

Object.defineProperty(process, 'arch', {
  get() {
    const stack = new Error().stack || '';
    const callerFrames = stack.split('\n').slice(2).join('\n');
    if (isSystemCall(callerFrames)) return REAL_ARCH;
    return 'arm64';
  },
  configurable: true
});

const originalOsPlatform = os.platform;
const originalOsArch = os.arch;

os.platform = function() {
  const stack = new Error().stack || '';
  const callerFrames = stack.split('\n').slice(2).join('\n');
  if (isSystemCall(callerFrames)) return originalOsPlatform.call(os);
  return 'darwin';
};

os.arch = function() {
  const stack = new Error().stack || '';
  const callerFrames = stack.split('\n').slice(2).join('\n');
  if (isSystemCall(callerFrames)) return originalOsArch.call(os);
  return 'arm64';
};

process.getSystemVersion = function() { return '14.0.0'; };

console.log('[Platform] Spoofing: darwin/arm64 macOS 14.0');

// ============================================================
// 2. MODULE INTERCEPTION - MUST BE BEFORE ELECTRON REQUIRE!
// ============================================================

const originalLoad = Module._load;
let swiftStubCache = null;
let loadingStub = false;

function loadSwiftStub() {
  if (swiftStubCache) return swiftStubCache;
  if (!fs.existsSync(STUB_PATH)) throw new Error(`Swift stub not found: ${STUB_PATH}`);
  loadingStub = true;
  try {
    delete require.cache[STUB_PATH];
    swiftStubCache = originalLoad.call(Module, STUB_PATH, module, false);
  } finally {
    loadingStub = false;
  }
  return swiftStubCache;
}

let patchedElectron = null;

Module._load = function(request, _parent, _isMain) {
  if (loadingStub) return originalLoad.apply(this, arguments);

  if (request.includes('swift_addon') && request.endsWith('.node')) {
    return loadSwiftStub();
  }
  if (request.includes('claude-native-binding') && request.endsWith('.node')) {
    return {};
  }
  if (request === 'electron' && patchedElectron) {
    return patchedElectron;
  }

  return originalLoad.apply(this, arguments);
};

console.log('[Module] Swift interception enabled');

// ============================================================
// 3. NOW SAFE TO LOAD ELECTRON AND PATCH IT
// ============================================================

const electron = require('electron');

// Patch app version - needed for anthropic-client-version header
const APP_VERSION = '1.1.2156';
electron.app.getVersion = function() { return APP_VERSION; };
electron.app.setVersion = function(v) {};
console.log(`[Version] Patched app.getVersion() to return ${APP_VERSION}`);

// Spoof User-Agent to macOS
electron.app.on('ready', () => {
  const ses = electron.session.defaultSession;
  const defaultUA = ses.getUserAgent();
  const macUA = defaultUA
    .replace(/X11; Linux x86_64/g, 'Macintosh; Intel Mac OS X 14_0')
    .replace(/X11; Linux aarch64/g, 'Macintosh; Apple M1 Mac OS X 14_0')
    .replace(/Electron\/[\d.]+/g, `Electron/39.4.0`)
    .replace(/Claude\/[\d.]+/g, `Claude/${APP_VERSION}`);
  ses.setUserAgent(macUA);
  console.log('[UserAgent] Spoofed to macOS');
});

// Intercept outgoing HTTP headers to fix platform detection
electron.app.on('ready', () => {
  const readySes = electron.session.defaultSession;
  const webReq = readySes.webRequest;
  const origOnBSH = webReq.onBeforeSendHeaders.bind(webReq);

  Object.defineProperty(webReq, 'onBeforeSendHeaders', {
    value: function patchedOnBeforeSendHeaders(filterOrHandler, maybeHandler) {
      let filter, handler;
      if (typeof filterOrHandler === 'function') {
        handler = filterOrHandler;
      } else {
        filter = filterOrHandler;
        handler = maybeHandler;
      }

      const wrappedHandler = (details, callback) => {
        handler(details, (result) => {
          const headers = result?.requestHeaders || details.requestHeaders;
          if (headers['anthropic-client-os-platform']) {
            headers['anthropic-client-os-platform'] = 'darwin';
          }
          callback({ requestHeaders: headers, cancel: result?.cancel });
        });
      };

      if (filter) return origOnBSH(filter, wrappedHandler);
      return origOnBSH(wrappedHandler);
    },
    writable: true, configurable: true, enumerable: true
  });
  console.log('[Headers] onBeforeSendHeaders patched');
});

// Patch systemPreferences with macOS-only APIs
const origSysPrefs = electron.systemPreferences || {};
const patchedSysPrefs = {
  getMediaAccessStatus: () => 'granted',
  askForMediaAccess: async () => true,
  getEffectiveAppearance: () => 'light',
  getAppearance: () => 'light',
  setAppearance: () => {},
  getAccentColor: () => '007AFF',
  getColor: () => '#007AFF',
  getUserDefault: () => null,
  setUserDefault: () => {},
  removeUserDefault: () => {},
  subscribeNotification: () => 0,
  unsubscribeNotification: () => {},
  subscribeWorkspaceNotification: () => 0,
  unsubscribeWorkspaceNotification: () => {},
  postNotification: () => {},
  postLocalNotification: () => {},
  isTrustedAccessibilityClient: () => true,
  isSwipeTrackingFromScrollEventsEnabled: () => false,
  isAeroGlassEnabled: () => false,
  isHighContrastColorScheme: () => false,
  isReducedMotion: () => false,
  isInvertedColorScheme: () => false,
};
for (const [key, val] of Object.entries(patchedSysPrefs)) {
  origSysPrefs[key] = val;
}

// Patch BrowserWindow prototype for macOS-only methods
const OrigBrowserWindow = electron.BrowserWindow;
const macOSWindowMethods = {
  setWindowButtonPosition: () => {},
  getWindowButtonPosition: () => ({ x: 0, y: 0 }),
  setTrafficLightPosition: () => {},
  getTrafficLightPosition: () => ({ x: 0, y: 0 }),
  setWindowButtonVisibility: () => {},
  setVibrancy: () => {},
  setBackgroundMaterial: () => {},
  setRepresentedFilename: () => {},
  getRepresentedFilename: () => '',
  setDocumentEdited: () => {},
  isDocumentEdited: () => false,
  setTouchBar: () => {},
  setSheetOffset: () => {},
  setAutoHideCursor: () => {},
};
for (const [method, impl] of Object.entries(macOSWindowMethods)) {
  if (typeof OrigBrowserWindow.prototype[method] !== 'function') {
    OrigBrowserWindow.prototype[method] = impl;
  }
}

// Wrap Menu
const OrigMenu = electron.Menu;
const origSetApplicationMenu = OrigMenu.setApplicationMenu;
OrigMenu.setApplicationMenu = function(menu) {
  try {
    if (origSetApplicationMenu) origSetApplicationMenu.call(OrigMenu, menu);
  } catch (e) {}
};

const origBuildFromTemplate = OrigMenu.buildFromTemplate;
OrigMenu.buildFromTemplate = function(template) {
  const filteredTemplate = (template || []).map(item => {
    const filtered = { ...item };
    if (filtered.role === 'services' || filtered.role === 'recentDocuments') return null;
    if (filtered.submenu && Array.isArray(filtered.submenu)) {
      filtered.submenu = filtered.submenu.filter(sub => {
        if (!sub) return false;
        if (sub.role === 'services' || sub.role === 'recentDocuments') return false;
        return true;
      });
    }
    return filtered;
  }).filter(Boolean);
  return origBuildFromTemplate.call(OrigMenu, filteredTemplate);
};

// ============================================================
// 3b. BROWSERWINDOW CONSTRUCTOR WRAPPING (titlebar fix)
// ============================================================
// electron.BrowserWindow is a non-configurable getter, so we can't replace
// it directly. Instead, we create a Proxy around the entire electron module
// that intercepts BrowserWindow access and returns a wrapped constructor.

const BrowserWindowProxy = new Proxy(OrigBrowserWindow, {
  construct(target, args, newTarget) {
    const options = args[0] || {};

    if (REAL_PLATFORM === 'linux') {
      // Quick Entry window (frameless + transparent) - leave as-is
      if (options.frame === false && options.transparent) {
        // no-op
      } else {
        // On Linux, titleBarStyle:"hidden" creates an invisible drag region
        // that intercepts all mouse events in the top ~36px.
        // Use native frame instead.
        options.titleBarStyle = 'default';
        options.frame = true;
        delete options.titleBarOverlay;
        delete options.trafficLightPosition;
      }
      options.autoHideMenuBar = true;
    }

    const instance = Reflect.construct(target, [options], newTarget);

    if (REAL_PLATFORM === 'linux') {
      try { instance.setMenuBarVisibility(false); } catch (e) {}
    }

    return instance;
  },
  get(target, prop, receiver) {
    return Reflect.get(target, prop, receiver);
  },
  set(target, prop, value, receiver) {
    return Reflect.set(target, prop, value, receiver);
  },
  [Symbol.hasInstance](instance) {
    return instance instanceof OrigBrowserWindow;
  }
});

const electronProxy = new Proxy(electron, {
  get(target, prop, receiver) {
    if (prop === 'BrowserWindow') return BrowserWindowProxy;
    return Reflect.get(target, prop, receiver);
  }
});

patchedElectron = electronProxy;
console.log('[Electron] Patched (systemPreferences + BrowserWindow + Menu)');

// ============================================================
// 4. IPC HANDLER INTERCEPTION
// ============================================================
// Intercept handler registration to wrap/override handlers that
// fail on Linux. This works regardless of eipc UUID.

const { ipcMain } = electron;

const supported = { status: 'supported' };
const unsupported = (reason) => ({ status: 'unsupported', reason });
const FORCE_OVERRIDES = {
  'AppFeatures_$_getSupportedFeatures': async () => ({
    nativeQuickEntry: unsupported('linux'),
    quickEntryDictation: unsupported('linux'),
    customQuickEntryDictationShortcut: unsupported('linux'),
    plushRaccoon: supported,
    quietPenguin: supported,
    louderPenguin: supported,
    chillingSlothEnterprise: supported,
    chillingSlothFeat: supported,
    chillingSlothLocal: supported,
    yukonSilver: supported,
    yukonSilverGems: supported,
    desktopTopBar: supported,
    desktopVoiceDictation: unsupported('linux'),
  }),
  'AppFeatures_$_getCoworkFeatureState': async () => ({
    enabled: true, status: 'supported', reason: null,
  }),
  'AppFeatures_$_getYukonSilverStatus': async () => ({
    status: 'supported',
  }),
  'AppFeatures_$_getFeatureFlags': async () => ({
    yukonSilver: true, cowork: true, localAgentMode: true,
  }),
};

const ERROR_FALLBACKS = {
  'ClaudeVM_$_download': async () => ({ status: 'ready', downloaded: true, progress: 100 }),
  'ClaudeVM_$_getDownloadStatus': async () => ({ status: 'ready', downloaded: true, progress: 100, version: 'linux-native-1.0.0' }),
  'ClaudeVM_$_getRunningStatus': async () => ({ running: true, connected: true, status: 'connected' }),
  'ClaudeVM_$_start': async () => ({ started: true, status: 'running' }),
  'ClaudeVM_$_stop': async () => ({ stopped: true }),
  'ClaudeVM_$_getSupportStatus': async () => ({ status: 'supported' }),
  'ClaudeCode_$_prepare': async () => ({ ready: true, status: 'ready' }),
  'Account_$_setAccountDetails': async () => ({ success: true }),
  'QuickEntry_$_setRecentChats': async () => ({ success: true }),
};

const origHandle = ipcMain.handle.bind(ipcMain);
const origRemoveHandler = ipcMain.removeHandler.bind(ipcMain);

ipcMain.handle = function(channel, handler) {
  for (const [pattern, override] of Object.entries(FORCE_OVERRIDES)) {
    if (channel.includes(pattern)) return origHandle(channel, override);
  }
  for (const [pattern, fallback] of Object.entries(ERROR_FALLBACKS)) {
    if (channel.includes(pattern)) {
      const appHandler = handler;
      const safeHandler = async (...args) => {
        try { return await appHandler(...args); }
        catch (e) { return await fallback(...args); }
      };
      return origHandle(channel, safeHandler);
    }
  }
  return origHandle(channel, handler);
};

ipcMain.removeHandler = function(channel) {
  for (const pattern of Object.keys(FORCE_OVERRIDES)) {
    if (channel.includes(pattern)) return;
  }
  return origRemoveHandler(channel);
};

const origOn = ipcMain.on.bind(ipcMain);
ipcMain.on = function(channel, handler) { return origOn(channel, handler); };

// ============================================================
// 5. PER-WEBCONTENTS IPC INTERCEPTION
// ============================================================
// The eipc library uses webContents.ipc.handle() instead of ipcMain.handle().

electron.app.on('web-contents-created', (event, webContents) => {
  if (!webContents.ipc) return;

  const origWcHandle = webContents.ipc.handle.bind(webContents.ipc);
  webContents.ipc.handle = function(channel, handler) {
    for (const [pattern, override] of Object.entries(FORCE_OVERRIDES)) {
      if (channel.includes(pattern)) return origWcHandle(channel, override);
    }
    for (const [pattern, fallback] of Object.entries(ERROR_FALLBACKS)) {
      if (channel.includes(pattern)) {
        const appHandler = handler;
        const safeHandler = async (evt, ...args) => {
          try { return await appHandler(evt, ...args); }
          catch (e) { return await fallback(evt, ...args); }
        };
        return origWcHandle(channel, safeHandler);
      }
    }
    return origWcHandle(channel, handler);
  };

  const origWcRemove = webContents.ipc.removeHandler.bind(webContents.ipc);
  webContents.ipc.removeHandler = function(channel) {
    for (const pattern of Object.keys(FORCE_OVERRIDES)) {
      if (channel.includes(pattern)) return;
    }
    return origWcRemove(channel);
  };
});

console.log('[IPC] Handler interception ready');

// ============================================================
// 6. ERROR HANDLING
// ============================================================

process.on('uncaughtException', (error) => {
  if (error.message && (
    error.message.includes('is not a function') ||
    error.message.includes('No handler registered')
  )) {
    console.error('[Error] Caught:', error.message);
    return;
  }
  throw error;
});

// ============================================================
// 7. LOAD APPLICATION
// ============================================================

console.log('='.repeat(60));
console.log('Loading Claude application...');
console.log('='.repeat(60));

require('./app/frame-fix-entry.js');

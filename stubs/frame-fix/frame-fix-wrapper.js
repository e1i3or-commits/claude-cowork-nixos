// frame-fix-wrapper.js - Inject frame fix and Cowork support before main app loads
const Module = require('module');
const originalRequire = Module.prototype.require;
const path = require('path');
const os = require('os');
const fs = require('fs');

console.log('[Frame Fix] Wrapper loaded');

const REAL_PLATFORM = process.platform;
const REAL_ARCH = process.arch;

// ============================================================
// TMPDIR FIX (also applied in linux-loader.js, but needed here
// in case frame-fix-wrapper is loaded in a child process)
// ============================================================
const vmBundleDir = path.join(os.homedir(), '.config/Claude/vm_bundles');
const vmTmpDir = path.join(vmBundleDir, 'tmp');
const claudeVmBundle = path.join(vmBundleDir, 'claudevm.bundle');

try {
  fs.mkdirSync(vmTmpDir, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = vmTmpDir;
  process.env.TMP = vmTmpDir;
  process.env.TEMP = vmTmpDir;
  os.tmpdir = function() { return vmTmpDir; };

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
} catch (e) {
  console.error('[TMPDIR] Setup failed:', e.message);
}

// fs.rename EXDEV fix
const originalRename = fs.rename;
const originalRenameSync = fs.renameSync;

fs.rename = function(oldPath, newPath, callback) {
  originalRename(oldPath, newPath, (err) => {
    if (err && err.code === 'EXDEV') {
      const readStream = fs.createReadStream(oldPath);
      const writeStream = fs.createWriteStream(newPath);
      readStream.on('error', callback);
      writeStream.on('error', callback);
      writeStream.on('close', () => { fs.unlink(oldPath, () => callback(null)); });
      readStream.pipe(writeStream);
    } else {
      callback(err);
    }
  });
};

fs.renameSync = function(oldPath, newPath) {
  try { return originalRenameSync(oldPath, newPath); }
  catch (err) {
    if (err.code === 'EXDEV') { fs.copyFileSync(oldPath, newPath); fs.unlinkSync(oldPath); return; }
    throw err;
  }
};

// ============================================================
// Platform Spoofing
// ============================================================
function isSystemCall(stack) {
  return stack.includes('node:internal') ||
         stack.includes('internal/modules') ||
         stack.includes('node:electron') ||
         stack.includes('electron/js2c') ||
         stack.includes('electron.asar') ||
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
// Cowork Support
// ============================================================
global.__cowork = { supported: true, status: 'supported', processes: new Map() };

const SESSIONS_BASE = path.join(os.homedir(), '.local/share/claude-cowork/sessions');
try { fs.mkdirSync(SESSIONS_BASE, { recursive: true, mode: 0o700 }); } catch(e) {}

global.getYukonSilverSupportStatus = function() { return 'supported'; };

console.log('[Cowork] Linux support enabled');

// ============================================================
// Module Require Interception
// ============================================================
Module.prototype.require = function(id) {
  if (id && id.includes('@ant/claude-swift')) {
    const swiftStub = originalRequire.apply(this, arguments);
    if (swiftStub && swiftStub.vm) {
      swiftStub.vm.getStatus = function() {
        return { supported: true, status: 'supported', running: true, connected: true };
      };
      swiftStub.vm.getSupportStatus = function() { return 'supported'; };
      swiftStub.vm.isSupported = function() { return true; };
    }
    return swiftStub;
  }

  const module = originalRequire.apply(this, arguments);

  if (id === 'electron') {
    const { ipcMain } = module;
    if (ipcMain && !global.__coworkIPCPatched) {
      global.__coworkIPCPatched = true;
      const originalHandle = ipcMain.handle.bind(ipcMain);
      ipcMain.handle = function(channel, handler) {
        if (channel.includes('ClaudeVM')) {
          const wrappedHandler = async (...args) => {
            const method = channel.split('_$_').pop();
            if (method === 'getRunningStatus') return { running: true, connected: true, ready: true, status: 'running' };
            if (method === 'getDownloadStatus') return { status: 'ready', downloaded: true, installed: true, progress: 100 };
            if (method === 'isSupported' || method === 'getSupportStatus') return 'supported';
            try { return await handler(...args); } catch(e) { return null; }
          };
          return originalHandle(channel, wrappedHandler);
        }
        return originalHandle(channel, handler);
      };
    }

    const OriginalBrowserWindow = module.BrowserWindow;
    const OriginalMenu = module.Menu;

    // Note: BrowserWindow constructor wrapping here is a secondary layer.
    // The primary fix is in linux-loader.js via the electron module Proxy.
    // This handles cases where code bypasses Module._load.

    const originalSetAppMenu = OriginalMenu.setApplicationMenu;
    module.Menu.setApplicationMenu = function(menu) {
      try {
        if (typeof originalSetAppMenu === 'function') originalSetAppMenu.call(OriginalMenu, menu);
      } catch (e) {}
      if (REAL_PLATFORM === 'linux') {
        try {
          for (const win of module.BrowserWindow.getAllWindows()) win.setMenuBarVisibility(false);
        } catch (e) {}
      }
    };
  }

  return module;
};

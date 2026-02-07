#!/usr/bin/env bash
#
# Claude Cowork for Linux - NixOS Installer
#
# Installs Claude Desktop with Cowork ("Chat | Cowork | Code" tabs) on NixOS.
# No sudo required - everything installs to user-space.
#
# Usage:
#   nix-shell -p _7zz nodejs electron nodePackages.asar curl python3 --run "bash install.sh"
#
# Or with a pre-downloaded installer:
#   CLAUDE_DMG=/path/to/Claude.dmg bash install.sh
#   CLAUDE_EXE=/path/to/Claude-Setup-x64.exe bash install.sh
#

set -euo pipefail

VERSION="1.0.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Download URL (macOS DMG - proven to work)
DMG_URL="https://storage.googleapis.com/osprey-downloads-c02f6a0d-347c-492b-a752-3e0651722e97/nest/Claude.dmg"
# Alternative: Windows exe (also works, different extraction path)
EXE_URL="https://storage.googleapis.com/osprey-downloads-c02f6a0d-347c-492b-a752-3e0651722e97/nest/Claude-Setup-x64.exe"

# Installation paths
INSTALL_DIR="$HOME/.local/share/claude-cowork/app"
RESOURCES_DIR="$INSTALL_DIR/Contents/Resources"
CONFIG_DIR="$HOME/.config/Claude"
LAUNCHER_DIR="$HOME/.local/bin"

# Temp directory
WORK_DIR=$(mktemp -d)
cleanup() { rm -rf "$WORK_DIR" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
die()         { log_error "$@"; exit 1; }

# ============================================================
# Step 1: Check Dependencies
# ============================================================

check_deps() {
    log_info "Checking dependencies..."
    local missing=()
    for cmd in 7zz node electron asar curl python3; do
        if command -v "$cmd" >/dev/null 2>&1; then
            log_success "Found: $cmd"
        else
            missing+=("$cmd")
        fi
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        die "Missing: ${missing[*]}
Run inside nix-shell:
  nix-shell -p _7zz nodejs electron nodePackages.asar curl python3 --run \"bash $0\""
    fi
}

# ============================================================
# Step 2: Download or Locate Installer
# ============================================================

get_installer() {
    # User-provided DMG
    if [[ -n "${CLAUDE_DMG:-}" ]]; then
        local resolved
        resolved=$(realpath -e "$CLAUDE_DMG" 2>/dev/null) || die "File not found: $CLAUDE_DMG"
        log_info "Using provided DMG: $resolved"
        INSTALLER_PATH="$resolved"
        INSTALLER_TYPE="dmg"
        return 0
    fi

    # User-provided EXE
    if [[ -n "${CLAUDE_EXE:-}" ]]; then
        local resolved
        resolved=$(realpath -e "$CLAUDE_EXE" 2>/dev/null) || die "File not found: $CLAUDE_EXE"
        log_info "Using provided EXE: $resolved"
        INSTALLER_PATH="$resolved"
        INSTALLER_TYPE="exe"
        return 0
    fi

    # Check current directory for existing downloads
    for f in "$SCRIPT_DIR"/Claude*.dmg "$SCRIPT_DIR"/Claude*.exe; do
        if [[ -f "$f" ]]; then
            log_info "Found: $f"
            read -r -p "Use this file? [Y/n] " response
            if [[ "${response:-Y}" =~ ^[Yy]$ ]]; then
                INSTALLER_PATH="$f"
                if [[ "$f" == *.exe ]]; then
                    INSTALLER_TYPE="exe"
                else
                    INSTALLER_TYPE="dmg"
                fi
                return 0
            fi
        fi
    done

    # Download macOS DMG (default - proven extraction path)
    log_info "Downloading Claude Desktop..."
    INSTALLER_PATH="$WORK_DIR/Claude.dmg"
    INSTALLER_TYPE="dmg"

    if ! curl -fSL --progress-bar -o "$INSTALLER_PATH" "$DMG_URL"; then
        die "Download failed. Try manually:
  1. Visit https://claude.ai/download
  2. Download the macOS or Windows version
  3. Re-run: CLAUDE_DMG=/path/to/Claude.dmg bash $0"
    fi

    local size
    size=$(stat -c%s "$INSTALLER_PATH" 2>/dev/null || echo 0)
    if [[ "$size" -lt 100000000 ]]; then
        die "Download too small (${size} bytes). May be incomplete or a redirect page."
    fi
    log_success "Downloaded ($((size / 1048576))MB)"
}

# ============================================================
# Step 3: Extract app.asar
# ============================================================

extract_app() {
    local extract_dir="$WORK_DIR/extract"
    mkdir -p "$extract_dir"

    if [[ "$INSTALLER_TYPE" == "dmg" ]]; then
        # DMG → 7zz → Claude.app/Contents/Resources/app.asar
        log_info "Extracting DMG..."
        7zz x -y -o"$extract_dir" "$INSTALLER_PATH" >/dev/null 2>&1 || die "Failed to extract DMG"

        local asar_file
        asar_file=$(find "$extract_dir" -name "app.asar" -path "*/Contents/Resources/*" | head -1)
        [[ -n "$asar_file" ]] || die "app.asar not found in DMG"
        ASAR_PATH="$asar_file"

        # Also save the Claude.app path for copying resources (icons, etc)
        CLAUDE_APP=$(find "$extract_dir" -name "Claude.app" -type d | head -1)

    elif [[ "$INSTALLER_TYPE" == "exe" ]]; then
        # EXE → 7zz → .nupkg → 7zz → app.asar
        log_info "Extracting Windows installer..."
        local exe_dir="$extract_dir/exe"
        mkdir -p "$exe_dir"
        7zz x -y -o"$exe_dir" "$INSTALLER_PATH" >/dev/null 2>&1 || die "Failed to extract EXE"

        local nupkg
        nupkg=$(find "$exe_dir" -name "*.nupkg" | head -1)
        [[ -n "$nupkg" ]] || die ".nupkg not found in EXE"

        local nupkg_dir="$extract_dir/nupkg"
        mkdir -p "$nupkg_dir"
        7zz x -y -o"$nupkg_dir" "$nupkg" >/dev/null 2>&1 || die "Failed to extract .nupkg"

        ASAR_PATH=$(find "$nupkg_dir" -name "app.asar" | head -1)
        [[ -n "$ASAR_PATH" ]] || die "app.asar not found in .nupkg"
        CLAUDE_APP=""
    fi

    log_success "Found app.asar"

    # Extract app.asar
    log_info "Extracting app.asar..."
    APP_EXTRACT="$WORK_DIR/app-extracted"
    asar extract "$ASAR_PATH" "$APP_EXTRACT" || die "Failed to extract app.asar"
    log_success "Extracted app code ($(du -sh "$APP_EXTRACT" | cut -f1))"
}

# ============================================================
# Step 4: Install to user-space
# ============================================================

install_app() {
    log_info "Installing to $INSTALL_DIR..."

    if [[ -d "$INSTALL_DIR" ]]; then
        log_warn "Removing previous installation..."
        rm -rf "$INSTALL_DIR"
    fi

    mkdir -p "$RESOURCES_DIR"

    # Copy extracted app code
    cp -r "$APP_EXTRACT" "$RESOURCES_DIR/app"

    # Copy icon and other resources from Claude.app (DMG only)
    if [[ -n "${CLAUDE_APP:-}" ]] && [[ -d "$CLAUDE_APP" ]]; then
        cp -r "$CLAUDE_APP/Contents/Resources/"*.icns "$RESOURCES_DIR/" 2>/dev/null || true
        cp -r "$CLAUDE_APP/Contents/Resources/"*.json "$RESOURCES_DIR/" 2>/dev/null || true
    fi

    log_success "App files installed"
}

# ============================================================
# Step 5: Install stubs from repo
# ============================================================

install_stubs() {
    log_info "Installing stubs..."

    # Copy stubs directory from repo
    mkdir -p "$RESOURCES_DIR/stubs"
    cp -r "$SCRIPT_DIR/stubs/@ant" "$RESOURCES_DIR/stubs/"

    # Also replace native modules in node_modules so regular requires work
    local app_nm="$RESOURCES_DIR/app/node_modules"

    # Handle @ant namespace
    if [[ -d "$app_nm/@ant/claude-swift/js" ]]; then
        cp "$SCRIPT_DIR/stubs/@ant/claude-swift/js/index.js" "$app_nm/@ant/claude-swift/js/index.js"
        log_success "Replaced @ant/claude-swift with stub"
    fi
    if [[ -d "$app_nm/@ant/claude-native" ]]; then
        cp "$SCRIPT_DIR/stubs/@ant/claude-native/index.js" "$app_nm/@ant/claude-native/index.js"
        log_success "Replaced @ant/claude-native with stub"
    fi

    # Handle @anthropic-ai namespace (older versions)
    if [[ -d "$app_nm/@anthropic-ai/claude-swift/js" ]]; then
        cp "$SCRIPT_DIR/stubs/@ant/claude-swift/js/index.js" "$app_nm/@anthropic-ai/claude-swift/js/index.js"
        log_success "Replaced @anthropic-ai/claude-swift with stub"
    fi
    if [[ -d "$app_nm/@anthropic-ai/claude-native" ]]; then
        mkdir -p "$app_nm/@anthropic-ai/claude-native"
        cp "$SCRIPT_DIR/stubs/@ant/claude-native/index.js" "$app_nm/@anthropic-ai/claude-native/index.js"
        log_success "Replaced @anthropic-ai/claude-native with stub"
    fi
}

# ============================================================
# Step 6: Apply patches
# ============================================================

apply_patches() {
    log_info "Applying topbar patches..."
    local index_js="$RESOURCES_DIR/app/.vite/build/index.js"

    if [[ ! -f "$index_js" ]]; then
        die "index.js not found at $index_js"
    fi

    python3 "$SCRIPT_DIR/patches/enable_topbar.py" "$index_js" || {
        log_warn "Patching returned non-zero. Topbar tabs may not appear."
        log_warn "Check if the app version changed and update patches accordingly."
    }

    log_success "Patches applied"
}

# ============================================================
# Step 7: Install loader and frame-fix
# ============================================================

install_loader() {
    log_info "Installing loader and frame-fix..."

    # Copy linux-loader.js from repo
    cp "$SCRIPT_DIR/linux-loader.js" "$RESOURCES_DIR/linux-loader.js"

    # Copy frame-fix files into app directory
    cp "$SCRIPT_DIR/stubs/frame-fix/frame-fix-entry.js" "$RESOURCES_DIR/app/frame-fix-entry.js"
    cp "$SCRIPT_DIR/stubs/frame-fix/frame-fix-wrapper.js" "$RESOURCES_DIR/app/frame-fix-wrapper.js"

    # Create package.json for electron to find the entry point
    cat > "$RESOURCES_DIR/package.json" << 'EOF'
{
  "name": "claude-desktop",
  "version": "1.0.0",
  "main": "linux-loader.js"
}
EOF

    # Link i18n locale files where the app expects them
    mkdir -p "$RESOURCES_DIR/app/resources/i18n"
    for f in "$RESOURCES_DIR/"*.json; do
        [[ -f "$f" ]] || continue
        local fname
        fname=$(basename "$f")
        [[ "$fname" == "package.json" ]] && continue
        ln -sf "$f" "$RESOURCES_DIR/app/resources/i18n/$fname" 2>/dev/null || true
    done

    log_success "Loader installed"
}

# ============================================================
# Step 8: Create NixOS-aware launcher
# ============================================================

create_launcher() {
    log_info "Creating launcher..."
    mkdir -p "$LAUNCHER_DIR"

    cat > "$LAUNCHER_DIR/claude-cowork" << 'LAUNCHER'
#!/usr/bin/env bash
# Claude Cowork launcher for NixOS
# Wraps with nix-shell to ensure electron is available at runtime

RESOURCES_DIR="$HOME/.local/share/claude-cowork/app/Contents/Resources"

# Parse arguments
ELECTRON_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --debug) export CLAUDE_TRACE=1 ;;
        --devtools) ELECTRON_ARGS+=("--inspect") ;;
        *) ELECTRON_ARGS+=("$arg") ;;
    esac
done

export ELECTRON_ENABLE_LOGGING=1

# Wayland support
if [[ -n "${WAYLAND_DISPLAY:-}" ]] || [[ "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
    export ELECTRON_OZONE_PLATFORM_HINT=wayland
fi

# Create log directory
LOG_DIR="$HOME/.local/share/claude-cowork/logs"
mkdir -p "$LOG_DIR"

cd "$RESOURCES_DIR"
exec nix-shell -p electron nodejs --run "electron linux-loader.js ${ELECTRON_ARGS[*]}" 2>&1 | tee -a "$LOG_DIR/startup.log"
LAUNCHER

    chmod +x "$LAUNCHER_DIR/claude-cowork"
    log_success "Launcher: $LAUNCHER_DIR/claude-cowork"

    if [[ ":$PATH:" != *":$LAUNCHER_DIR:"* ]]; then
        log_warn "$LAUNCHER_DIR is not in your PATH"
        log_info "Add to your shell config:  export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
}

# ============================================================
# Step 9: Create desktop entry
# ============================================================

create_desktop_entry() {
    log_info "Creating desktop entry..."
    mkdir -p ~/.local/share/applications

    # Find icon
    local icon_path=""
    if [[ -f "$RESOURCES_DIR/icon.icns" ]]; then
        icon_path="$RESOURCES_DIR/icon.icns"
    elif [[ -f "$RESOURCES_DIR/electron.icns" ]]; then
        icon_path="$RESOURCES_DIR/electron.icns"
    fi

    cat > ~/.local/share/applications/claude-cowork.desktop << EOF
[Desktop Entry]
Type=Application
Name=Claude Cowork
Comment=Anthropic Claude Desktop with Cowork support
Exec=$LAUNCHER_DIR/claude-cowork
Icon=${icon_path}
Terminal=false
Categories=Utility;Development;Chat;
Keywords=AI;assistant;chat;anthropic;claude;cowork;
StartupWMClass=Claude
EOF

    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database ~/.local/share/applications 2>/dev/null || true
    fi

    log_success "Desktop entry created"
}

# ============================================================
# Step 10: Setup user directories
# ============================================================

setup_user_dirs() {
    log_info "Setting up config directories..."

    mkdir -p "$CONFIG_DIR"/{Projects,Conversations,vm_bundles}
    mkdir -p "$HOME/.local/share/claude-cowork"/{logs,sessions}

    if [[ ! -f "$CONFIG_DIR/config.json" ]]; then
        cat > "$CONFIG_DIR/config.json" << 'EOF'
{
  "scale": 0,
  "locale": "en-US",
  "userThemeMode": "system",
  "hasTrackedInitialActivation": false
}
EOF
    fi

    if [[ ! -f "$CONFIG_DIR/claude_desktop_config.json" ]]; then
        cat > "$CONFIG_DIR/claude_desktop_config.json" << 'EOF'
{
  "preferences": {
    "chromeExtensionEnabled": true
  }
}
EOF
    fi

    chmod 700 "$CONFIG_DIR"
    log_success "Config directories ready"
}

# ============================================================
# Main
# ============================================================

main() {
    echo ""
    echo "=========================================="
    echo " Claude Cowork for Linux - NixOS Installer"
    echo " Version: $VERSION"
    echo "=========================================="
    echo ""
    echo " Install dir:  $INSTALL_DIR"
    echo " Launcher:     $LAUNCHER_DIR/claude-cowork"
    echo " No sudo required"
    echo ""

    [[ $EUID -eq 0 ]] && die "Do not run as root."

    check_deps
    echo ""

    get_installer
    echo ""

    extract_app
    echo ""

    install_app
    echo ""

    install_stubs
    echo ""

    apply_patches
    echo ""

    install_loader
    echo ""

    create_launcher
    echo ""

    create_desktop_entry
    echo ""

    setup_user_dirs
    echo ""

    echo "=========================================="
    echo -e "${GREEN} Installation Complete!${NC}"
    echo "=========================================="
    echo ""
    echo "Launch Claude Cowork:"
    echo "  claude-cowork"
    echo ""
    echo "Options:"
    echo "  claude-cowork --debug      Enable trace logging"
    echo "  claude-cowork --devtools   Enable Chrome DevTools"
    echo ""
    echo "Logs: ~/.local/share/claude-cowork/logs/startup.log"
    echo ""
    echo "Note: First launch may be slow while Nix fetches electron."
    echo ""
}

main "$@"

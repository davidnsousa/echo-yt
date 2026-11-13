#!/usr/bin/env bash
# install.sh - echo-yt installer (from the deskapp install_template.sh).
#
#   ./install.sh               install, or update an existing install
#   ./install.sh --uninstall   remove echo-yt completely, -R for short
#   ./install.sh --help        show usage
#
# Installs the shared copy at /opt/echo-yt (needs sudo, since it's a
# system directory shared by all users):
#
#   /opt/echo-yt/echo-yt    the launcher (from launcher.sh):
#                             /usr/local/bin/echo-yt and the app-menu entry
#                             point here; it only starts the app
#   /opt/echo-yt/install.sh  a copy of this script, so
#                             'echo-yt --uninstall' works once the source
#                             folder is gone
#   /opt/echo-yt/.venv       Python venv, kept across updates
#
# Each user's own data lives separately, in ~/.config/echo-yt/,
# not under /opt.

set -euo pipefail

COMMAND_NAME="echo-yt"
INSTALL_DIR="/opt/echo-yt"
LAUNCHER="$INSTALL_DIR/$COMMAND_NAME"
APP_FILE="main.py"
REQ_FILE="requirements.txt"
# everything else copied to $INSTALL_DIR besides $APP_FILE and $REQ_FILE (files or dirs)
EXTRA_FILES=(static)
DESKTOP_FILE="/usr/local/share/applications/$COMMAND_NAME.desktop"
# app-menu icon: an SVG inside the source folder (e.g. static/icon.svg; it must
# also be copied, via EXTRA_FILES), or leave ICON_SRC empty and set ICON_NAME
# to a theme icon instead (e.g. system-file-manager)
ICON_SRC="static/icon.svg"
ICON_NAME=""
ICON_FILE="/usr/local/share/icons/hicolor/scalable/apps/$COMMAND_NAME.svg"
MENU_ENTRY=yes   # yes: install an app-menu entry, no: command only
# yes: systemd listens on PORT for every user and starts the app on the
# first visit (it stops itself again once the last tab is closed), so a
# bookmark or a tab restored after a reboot just works and nothing runs
# while it isn't used; no: it only starts from the menu or the command
SOCKET_ACTIVATION=yes
PORT="8247"   # keep in sync with PORT in launcher.sh
UNIT_DIR="/usr/local/lib/systemd/user"
SOCKET_UNIT="$COMMAND_NAME.socket"
SERVICE_UNIT="$COMMAND_NAME.service"
# What an update does to a copy of echo-yt this user has running:
# restart (background server/daemon: stop it, start it again with --start)
# or leave (a window or terminal app: stopping it could lose unsaved work)
RUNNING_ON_UPDATE=restart
# pacman packages the app needs besides Python itself
SYSTEM_PKGS=(python xdg-utils yt-dlp ffmpeg)

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

info()  { echo -e "${GREEN}[*]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; }

confirm() {
    local reply
    read -r -p "$1 [y/n]: " reply
    case "$reply" in
        y|Y|yes|Yes|YES) return 0 ;;
        *) return 1 ;;
    esac
}

usage() {
    cat <<'EOF'
install.sh - install, update or remove echo-yt

usage:
  ./install.sh                  install echo-yt, or update an existing install
                                (needs sudo, since it installs/updates the
                                shared copy at /opt/echo-yt)
  ./install.sh --uninstall, -R  remove echo-yt completely (app dir + symlink +
                                app-menu entry); same as 'echo-yt --uninstall'
  ./install.sh --help           show this help

once installed, see 'echo-yt --help' for how to use it.
EOF
}

app_pids() {
    # echo-yt processes this user is running from the installed copy
    pgrep -u "$(id -u)" -f "^$INSTALL_DIR/.venv/bin/python $INSTALL_DIR/$APP_FILE" || true
}

stop_running() {
    # Stop this user's running echo-yt, so it doesn't keep running the old
    # code (or hold files under $INSTALL_DIR) during an update or uninstall.
    # Prints the launcher arguments to start it again the same way (e.g.
    # "--port 9000", read from the process's ECHO_YT_PORT), or "-" for
    # the defaults; prints nothing if it wasn't running.
    local pids pid port i
    pids="$(app_pids)"
    [ -z "$pids" ] && return
    pid="${pids%%$'\n'*}"
    port="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^ECHO_YT_PORT=//p' || true)"
    warn "Stopping the running $COMMAND_NAME." >&2
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for i in $(seq 50); do
        [ -z "$(app_pids)" ] && break
        sleep 0.1
    done
    pids="$(app_pids)"
    # shellcheck disable=SC2086
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
    if [ -n "$port" ]; then echo "--port $port"; else echo "-"; fi
}

have_user_systemd() {
    command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

stop_socket() {
    # Stop this user's listening socket (and the app it started), so nothing
    # starts the app while its files are being replaced or removed
    have_user_systemd || return 0
    systemctl --user stop "$SOCKET_UNIT" "$SERVICE_UNIT" >/dev/null 2>&1 || true
}

install_socket_units() {
    # systemd user units shared by all users: the socket listens on PORT
    # from login on (costs no memory), and the first connection starts the
    # service, which serves that request and every later one until the last
    # tab is closed - then the app exits and the socket waits again
    if [ "$SOCKET_ACTIVATION" != yes ] || ! have_user_systemd; then
        remove_socket_units quiet
        return 0
    fi
    sudo mkdir -p "$UNIT_DIR"
    sudo tee "$UNIT_DIR/$SOCKET_UNIT" >/dev/null <<EOF
[Unit]
Description=$COMMAND_NAME - starts it on the first visit to http://127.0.0.1:$PORT

[Socket]
ListenStream=127.0.0.1:$PORT

[Install]
WantedBy=sockets.target
EOF
    sudo tee "$UNIT_DIR/$SERVICE_UNIT" >/dev/null <<EOF
[Unit]
Description=$COMMAND_NAME (started on demand by $SOCKET_UNIT)
Requires=$SOCKET_UNIT
After=$SOCKET_UNIT

[Service]
Type=simple
Environment=ECHO_YT_PORT=$PORT
ExecStart=$INSTALL_DIR/.venv/bin/python $INSTALL_DIR/$APP_FILE
# it exits by itself once no tab is open; the socket starts it again
Restart=no
EOF
    sudo chmod 644 "$UNIT_DIR/$SOCKET_UNIT" "$UNIT_DIR/$SERVICE_UNIT"
    # enabled for every user from their next login on...
    sudo systemctl --global enable "$SOCKET_UNIT" >/dev/null 2>&1 \
        || warn "Couldn't enable $SOCKET_UNIT for every user - others can run 'systemctl --user enable --now $SOCKET_UNIT'"
    # ...and for this user right away
    systemctl --user daemon-reload
    if systemctl --user start "$SOCKET_UNIT"; then
        info "Starts on demand: opening http://127.0.0.1:$PORT starts $COMMAND_NAME ($UNIT_DIR/$SOCKET_UNIT)"
    else
        warn "Couldn't listen on port $PORT (something else is using it?) - start $COMMAND_NAME from the app menu instead."
    fi
}

remove_socket_units() {
    [ -f "$UNIT_DIR/$SOCKET_UNIT" ] || [ -f "$UNIT_DIR/$SERVICE_UNIT" ] || return 0
    stop_socket
    sudo systemctl --global disable "$SOCKET_UNIT" >/dev/null 2>&1 || true
    sudo rm -f "${UNIT_DIR:?}/${SOCKET_UNIT:?}" "${UNIT_DIR:?}/${SERVICE_UNIT:?}"
    if have_user_systemd; then systemctl --user daemon-reload || true; fi
    [ "${1:-}" = quiet ] || info "Removed the systemd units from $UNIT_DIR"
}

uninstall() {
    local symlink_path="/usr/local/bin/$COMMAND_NAME"

    warn "This will remove:"
    [ -d "$INSTALL_DIR" ]  && echo "    $INSTALL_DIR (app + venv, needs sudo - system directory)"
    [ -L "$symlink_path" ] && echo "    $symlink_path (symlink, needs sudo)"
    [ -f "$DESKTOP_FILE" ] && echo "    $DESKTOP_FILE (app-menu entry, needs sudo)"
    [ -f "$UNIT_DIR/$SOCKET_UNIT" ] && echo "    $UNIT_DIR/$SOCKET_UNIT and $SERVICE_UNIT (start on demand, needs sudo)"
    if [ ! -d "$INSTALL_DIR" ] && [ ! -L "$symlink_path" ] && [ ! -f "$DESKTOP_FILE" ] && [ ! -f "$UNIT_DIR/$SOCKET_UNIT" ]; then
        info "Nothing to remove - $COMMAND_NAME is not installed."
        exit 0
    fi
    warn "Your echo-yt data is never touched by this uninstall (it lives in ~/.config/echo-yt/, not under $INSTALL_DIR)."
    if ! confirm "Remove $COMMAND_NAME completely?"; then
        error "Aborted."
        exit 1
    fi

    remove_socket_units
    if [ "$RUNNING_ON_UPDATE" = restart ]; then
        stop_running >/dev/null
    elif [ -n "$(app_pids)" ]; then
        warn "$COMMAND_NAME is still open - close it; it can't start again once removed."
    fi

    if [ -L "$symlink_path" ]; then
        local target
        target="$(readlink -f "$symlink_path" 2>/dev/null || true)"
        if [ "$target" = "$LAUNCHER" ]; then
            warn "Removing $symlink_path needs sudo, since it is a system directory."
            sudo rm "$symlink_path"
            info "Removed $symlink_path"
        else
            warn "$symlink_path points elsewhere ($target) - leaving it untouched."
        fi
    fi

    [ -f "$ICON_FILE" ] && sudo rm "$ICON_FILE" && info "Removed $ICON_FILE"
    if [ -f "$DESKTOP_FILE" ]; then
        sudo rm "$DESKTOP_FILE"
        command -v update-desktop-database >/dev/null 2>&1 && sudo update-desktop-database -q "$(dirname "$DESKTOP_FILE")" || true
        info "Removed $DESKTOP_FILE"
    fi

    if [ -d "$INSTALL_DIR" ]; then
        warn "Removing $INSTALL_DIR needs sudo, since it is a system directory."
        sudo rm -rf "$INSTALL_DIR" "$INSTALL_DIR.new" "$INSTALL_DIR.old"
        info "Removed $INSTALL_DIR"
    fi

    info "$COMMAND_NAME removed."
    exit 0
}

check_system_deps() {
    if ! command -v pacman >/dev/null 2>&1; then
        warn "pacman not found - make sure these (or your distro's equivalents) are installed: ${SYSTEM_PKGS[*]}"
        return
    fi
    local missing=() pkg
    for pkg in "${SYSTEM_PKGS[@]}"; do
        pacman -Q "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
    done
    if [ "${#missing[@]}" -gt 0 ]; then
        warn "Missing: ${missing[*]} - installing with pacman (needs sudo, since it writes to system directories)."
        sudo pacman -S --needed --noconfirm "${missing[@]}"
    fi
    info "System dependencies OK"
}

check_pot_provider() {
    # The bgutil PoToken provider makes the tokens YouTube's bot check asks
    # for, so "Sign in to confirm you're not a bot" happens far less often.
    # It's only in the AUR, so it needs an AUR helper; echo-yt works without it.
    command -v bgutil-pot >/dev/null 2>&1 && { info "PoToken provider OK"; return; }
    local helper
    helper="$(command -v paru || command -v yay || true)"
    if [ -z "$helper" ]; then
        warn "No AUR helper (paru or yay) found - install bgutil-ytdlp-pot-provider from the AUR yourself to make YouTube's bot check less likely."
        return
    fi
    info "Installing the PoToken provider (bgutil-ytdlp-pot-provider) from the AUR with $(basename "$helper")."
    "$helper" -S --needed --noconfirm bgutil-ytdlp-pot-provider \
        || warn "PoToken provider not installed - echo-yt works without it."
}

stage_files() {
    # Copy the new app files into $INSTALL_DIR.new first, so a failed copy
    # leaves the current install untouched (swap_in_staged moves it into place)
    local source_dir="$1" staged="$INSTALL_DIR.new"

    sudo rm -rf "$staged" "$INSTALL_DIR.old"   # leftovers from an interrupted run
    sudo mkdir -p "$staged"
    sudo cp "$source_dir/$APP_FILE"      "$staged/$APP_FILE"
    sudo cp "$source_dir/$REQ_FILE"      "$staged/$REQ_FILE"
    local f
    for f in "${EXTRA_FILES[@]}"; do
        sudo cp -r "$source_dir/$f" "$staged/$f"
    done
    sudo cp "$source_dir/install.sh"     "$staged/install.sh"
    sudo cp "$source_dir/launcher.sh"    "$staged/$COMMAND_NAME"
    sudo chmod +x "$staged/$COMMAND_NAME" "$staged/install.sh"
    # Readable by every user whatever the umask was when the files were copied
    sudo chmod -R a+rX "$staged"
}

swap_in_staged() {
    # Move the staged copy into place, carrying the existing .venv over so
    # already-installed Python packages are reused (see install_deps)
    local staged="$INSTALL_DIR.new"

    if [ -d "$INSTALL_DIR" ]; then
        info "Updating existing install at $INSTALL_DIR (needs sudo; your $COMMAND_NAME data lives in ~/.config/echo-yt/, never under $INSTALL_DIR)"
        [ -d "$INSTALL_DIR/.venv" ] && sudo mv "$INSTALL_DIR/.venv" "$staged/.venv"
        sudo mv "$INSTALL_DIR" "$INSTALL_DIR.old"
        sudo mv "$staged" "$INSTALL_DIR"
        sudo rm -rf "$INSTALL_DIR.old"
    else
        info "Installing to $INSTALL_DIR (needs sudo, since it's a system directory shared by all users)"
        sudo mv "$staged" "$INSTALL_DIR"
    fi
    info "Copied app files to $INSTALL_DIR"
}

manage_symlink() {
    local symlink_path="/usr/local/bin/$COMMAND_NAME"
    local target="$LAUNCHER"

    if [ -L "$symlink_path" ]; then
        local current_target
        current_target="$(readlink -f "$symlink_path" 2>/dev/null || true)"
        if [ "$current_target" = "$target" ]; then
            info "'$COMMAND_NAME' already points to installed copy - nothing to do"
            return
        fi
        warn "'$COMMAND_NAME' exists but points elsewhere ($current_target)."
        warn "Updating $symlink_path needs sudo, since it is a system directory."
        sudo ln -sf "$target" "$symlink_path"
        info "Updated: $COMMAND_NAME -> $target"
    elif [ -e "$symlink_path" ]; then
        error "$symlink_path exists and isn't a symlink this script manages - leaving it untouched."
    else
        warn "Creating $symlink_path needs sudo, since it is a system directory."
        sudo ln -s "$target" "$symlink_path"
        info "Created: $COMMAND_NAME -> $target (launch from anywhere: terminal, dmenu)"
    fi
}

install_desktop_file() {
    # App-menu entry for every user
    if [ "$MENU_ENTRY" != yes ]; then
        # e.g. a converted app that had one before
        [ -f "$DESKTOP_FILE" ] && sudo rm "$DESKTOP_FILE" && info "Removed old app-menu entry $DESKTOP_FILE"
        return 0
    fi
    local icon="$ICON_NAME"
    sudo mkdir -p "$(dirname "$DESKTOP_FILE")"
    if [ -n "$ICON_SRC" ]; then
        sudo mkdir -p "$(dirname "$ICON_FILE")"
        sudo install -m 644 "$INSTALL_DIR/$ICON_SRC" "$ICON_FILE"
        command -v gtk-update-icon-cache >/dev/null 2>&1 && sudo gtk-update-icon-cache -q -t /usr/local/share/icons/hicolor 2>/dev/null || true
        icon="$COMMAND_NAME"
    fi
    sudo tee "$DESKTOP_FILE" >/dev/null <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=echo-yt
GenericName=Video Player
Comment=Search and watch YouTube through yt-dlp, with playlists, channels and history
Icon=$icon
Exec=$LAUNCHER --open
Terminal=false
Categories=AudioVideo;Video;Player;
Keywords=youtube;yt-dlp;video;playlist;
StartupNotify=false
EOF
    sudo chmod 644 "$DESKTOP_FILE"
    command -v update-desktop-database >/dev/null 2>&1 && sudo update-desktop-database -q "$(dirname "$DESKTOP_FILE")" || true
    info "App-menu entry: $DESKTOP_FILE"
}

setup_venv() {
    local venv_dir="$INSTALL_DIR/.venv"
    # A venv is tied to the Python version that made it: after a pacman
    # upgrade to a new Python (e.g. 3.14 -> 3.15) its packages - pip
    # included - are no longer importable, so start over with a fresh one
    if [ -d "$venv_dir" ] && ! "$venv_dir/bin/python" -c "import pip" >/dev/null 2>&1; then
        warn "The venv at $venv_dir no longer works (Python was probably upgraded) - recreating it (needs sudo)."
        sudo rm -rf "$venv_dir"
    fi
    if [ ! -d "$venv_dir" ]; then
        info "Creating virtual environment at $venv_dir (needs sudo, since $INSTALL_DIR is a system directory)"
        sudo python3 -m venv "$venv_dir"
    fi
}

install_deps() {
    # Run pip only when requirements.txt differs from the one last installed
    # (its hash is kept in the venv), so re-runs are fast and changed or
    # newly pinned versions are still picked up
    local stamp="$INSTALL_DIR/.venv/.requirements.sha256" hash
    hash="$(sha256sum "$INSTALL_DIR/$REQ_FILE" | cut -d' ' -f1)"
    if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$hash" ]; then
        info "Python dependencies already satisfied"
        return
    fi
    info "Installing Python dependencies from $REQ_FILE (needs sudo, since the venv lives under $INSTALL_DIR)"
    sudo "$INSTALL_DIR/.venv/bin/pip" install -q --disable-pip-version-check -r "$INSTALL_DIR/$REQ_FILE"
    echo "$hash" | sudo tee "$stamp" >/dev/null
}

# the date of the commit installed, for the update check (not saved when this
# copy of the repository is not a git clone)
record_installed_commit() {
    local src state date
    src=$(cd "$(dirname "$0")" && pwd)
    state=$HOME/.local/state/$COMMAND_NAME
    mkdir -p "$state"
    if date=$(git -C "$src" log -1 --format=%cI 2>/dev/null); then
        echo "$date" > "$state/installed"
    fi
}

next_steps() {
    cat <<EOF

  echo-yt is installed. Start it from the app menu, or run
  'echo-yt' in a terminal. See 'echo-yt --help' for all options.

EOF
}

main() {
    case "${1:-}" in
        "")                     ;;
        --help|-h)              usage; exit 0 ;;
        --uninstall|-R|--R)     uninstall ;;
        *)                      error "Unknown option $1"; usage; exit 1 ;;
    esac

    local source_dir
    source_dir="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
    if [ "$source_dir" = "$INSTALL_DIR" ]; then
        error "This is the installed copy - run install.sh from the source folder to update."
        exit 1
    fi

    check_system_deps
    check_pot_provider
    stage_files "$source_dir"
    # stopped only once the new files are staged, so it's down as briefly as possible
    local restart_args=""
    stop_socket
    if [ "$RUNNING_ON_UPDATE" = restart ]; then
        restart_args="$(stop_running)"
    elif [ -n "$(app_pids)" ]; then
        warn "$COMMAND_NAME is open - it keeps running the old version until you close and reopen it."
    fi
    swap_in_staged
    manage_symlink
    install_desktop_file
    setup_venv
    install_deps
    record_installed_commit
    install_socket_units
    if [ "$restart_args" = "-" ] && [ "$SOCKET_ACTIVATION" = yes ] && have_user_systemd \
        && systemctl --user is-active --quiet "$SOCKET_UNIT"; then
        # on the default port the socket starts it again as soon as an open tab reconnects
        info "Open $COMMAND_NAME tabs reconnect to the new code by themselves"
        restart_args=""
    fi
    if [ -n "$restart_args" ]; then
        # back in the background, like the app menu starts it; open tabs reconnect
        [ "$restart_args" = "-" ] && restart_args=""
        # shellcheck disable=SC2086
        "$LAUNCHER" $restart_args --start
        info "Restarted $COMMAND_NAME with the new code"
    fi
    next_steps
}

main "$@"

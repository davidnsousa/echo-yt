#!/usr/bin/env bash
# echo-yt launcher (from the deskapp launcher_web.sh). install.sh
# copies this file to /opt/echo-yt/echo-yt; /usr/local/bin/echo-yt
# and the app-menu entry point to it. It only starts the app - installing,
# updating and removing are install.sh's job.

set -euo pipefail

COMMAND_NAME="echo-yt"
INSTALL_DIR="/opt/echo-yt"
APP_FILE="main.py"
PORT="8247"

RED='\033[0;31m'; NC='\033[0m'
error() { echo -e "${RED}[x]${NC} $1"; }

usage() {
    cat <<'EOF'
echo-yt - Search and watch YouTube through yt-dlp, with playlists, channels and history

usage:
  echo-yt                     launch in this terminal
  echo-yt --open              start echo-yt in the background if it isn't
                               running, and open it in your default browser
                               (what the app-menu entry runs); it stops by
                               itself once you close the last echo-yt tab
  echo-yt --start             like --open, but without opening the browser
  echo-yt --port N ...        use port N instead of the default 8247 (combine
                               with any of the above, e.g. echo-yt --port 9000 --open)
  echo-yt --help              show this help
  echo-yt --uninstall, -R     remove echo-yt completely (app dir + symlink)

You usually don't need to start it at all: install.sh sets up systemd to
listen on http://127.0.0.1:8247 and start echo-yt on the first visit, so a
bookmark or a tab restored after a reboot just works. Nothing runs until then,
and it stops itself again once you close the last tab.

install / update:
  run ./install.sh from the source folder
EOF
}

server_running() {
    (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
}

start_in_background() {
    # Start the server in the background unless it's already running. Server
    # output goes to a log file, since there's no terminal to show it.
    # ECHO_YT_AUTO_STOP makes the server stop by itself once the last
    # echo-yt tab is closed.
    server_running && return
    local log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/$COMMAND_NAME"
    mkdir -p "$log_dir"
    ECHO_YT_AUTO_STOP=1 setsid "$INSTALL_DIR/.venv/bin/python" "$INSTALL_DIR/$APP_FILE" >"$log_dir/server.log" 2>&1 < /dev/null &
    local i
    for i in $(seq 100); do
        server_running && break
        sleep 0.1
    done
    if ! server_running; then
        error "$COMMAND_NAME did not start - see $log_dir/server.log"
        exit 1
    fi
}

socket_activated() {
    # install.sh set up systemd to listen on this port and start the app on
    # the first visit (and the app stops itself once no tab is open)
    command -v systemctl >/dev/null 2>&1 \
        && systemctl --user is-active --quiet "$COMMAND_NAME.socket" 2>/dev/null \
        && [ "$(systemctl --user show -P Listen "$COMMAND_NAME.socket" 2>/dev/null)" = "127.0.0.1:$PORT (Stream)" ]
}

open_in_browser() {
    # with socket activation, opening the page is what starts it
    socket_activated || start_in_background
    xdg-open "http://127.0.0.1:$PORT" >/dev/null 2>&1 &
}

run_app() {
    # pass only the non-flag arguments (e.g. a file to open) through to the app
    local app_args=() a
    for a in "$@"; do
        case "$a" in
            -*) ;;
            *) app_args+=("$a") ;;
        esac
    done
    if socket_activated; then
        echo "$COMMAND_NAME starts by itself when you open http://127.0.0.1:$PORT"
        echo "(systemd listens on that port for it). To run it in this terminal"
        echo "instead, use another port, e.g. '$COMMAND_NAME --port 9000'."
        exit 0
    fi
    echo "Serving at http://127.0.0.1:$PORT"
    exec "$INSTALL_DIR/.venv/bin/python" "$INSTALL_DIR/$APP_FILE" "${app_args[@]}"
}

# pull --port N / --port=N out of the arguments before anything else reads them
args=()
while [ $# -gt 0 ]; do
    case "$1" in
        --port)
            [ $# -ge 2 ] || { error "--port needs a number"; exit 1; }
            PORT="$2"; shift 2 ;;
        --port=*)
            PORT="${1#--port=}"; shift ;;
        *)
            args+=("$1"); shift ;;
    esac
done
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    error "invalid port: $PORT"
    exit 1
fi
# the app reads its port from here; install.sh also reads it back from a
# running server to restart it on the same port after an update
export ECHO_YT_PORT="$PORT"
set -- "${args[@]}"

for arg in "$@"; do
    case "$arg" in
        --help|-h)          usage; exit 0 ;;
        --uninstall|-R|--R) exec "$INSTALL_DIR/install.sh" --uninstall ;;
        --open)             open_in_browser; exit 0 ;;
        --start)            start_in_background; exit 0 ;;
    esac
done
run_app "$@"

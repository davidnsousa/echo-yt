# echo-yt

A local desktop frontend to [yt-dlp](https://github.com/yt-dlp/yt-dlp): search YouTube and watch inside the app, build playlists, save channels, and keep a watch and search history. No Google account, and nothing leaves your machine except the requests yt-dlp and the player make to YouTube.

## Features

- **Search** by keywords, or paste a video, channel or playlist link
- **In-app player** with up to 4K, chapters, speed control, resume where you left off, and live streams
- **Mini-player** that keeps playing in the corner while you browse
- **Playlists**: create, rename, reorder by dragging, play in order or shuffled
- **Saved channels** with a combined feed of their latest uploads
- **History** of what you watched (grouped by day, filterable) and what you searched

## Requirements

Arch Linux (or anything with these installed): `python`, `yt-dlp`, `ffmpeg` (for live streams), and a JavaScript runtime that yt-dlp can use (`deno` or `node`). On Arch, `install.sh` installs what's missing. On other distros it warns you and you install them yourself.

If YouTube playback stops working, update yt-dlp first: `sudo pacman -Syu yt-dlp`.

## Install

```bash
./install.sh
```

Run it again to update. See `echo-yt --help` for options. Remove with `./install.sh --uninstall` or `echo-yt -R`; your data stays.

## Usage

| Command | What it does |
|---|---|
| `echo-yt --open` | open in your browser, starting it if needed (what the app menu runs); stops when the last tab closes |
| `echo-yt` | run in this terminal |
| `echo-yt --start` | start in the background without opening a browser |
| `echo-yt --port N ...` | use port N instead of 8247 |
| `echo-yt --help` | show all options |

You usually don't need to start it at all. The installer sets up a systemd user socket on `http://127.0.0.1:8247`, so opening that address, a bookmark or a restored tab starts echo-yt on demand. Nothing runs until then. To run it in a terminal while the socket is active, use another port, e.g. `echo-yt --port 9000`.

## Keys

| Key | Action |
|---|---|
| `/` | search |
| `Space` / `k` | play or pause |
| `←` `→` | back or forward 5 s |
| `j` `l` | back or forward 10 s |
| `n` `p` | next or previous in the queue |
| `m` | mute |
| `f` | fullscreen |

## Your data

Playlists, channels and history live in `~/.config/echo-yt/echo-yt.db` (SQLite). Install, update and uninstall never touch it. Server logs from background runs are in `~/.local/state/echo-yt/`.

## Disclaimer

echo-yt is an independent project, not affiliated with or endorsed by YouTube or Google. You are responsible for following YouTube's terms of service and the laws where you live.

## Credits and licence

Built on [yt-dlp](https://github.com/yt-dlp/yt-dlp). Includes the [Inter](https://rsms.me/inter/) font under the SIL Open Font License (`static/fonts/Inter-LICENSE.txt`).

echo-yt is released under the MIT License. See `LICENSE`.

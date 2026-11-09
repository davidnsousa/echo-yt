#!/usr/bin/env python3
"""echo-yt - search, watch, collect. A local frontend to yt-dlp.

FastAPI server + browser UI. yt-dlp does all the talking to YouTube; this file
turns its JSON into something the page can use, keeps playlists, saved channels
and history in SQLite, and relays the media streams to the page's player.
"""

import asyncio
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import socket
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import httpx
import uvicorn
from fastapi import Body, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

STATIC_DIR = Path(__file__).parent / "static"
# the launcher's --port sets ECHO_YT_PORT
PORT = int(os.environ.get("ECHO_YT_PORT", "8247"))

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "echo-yt"
DB_PATH = CONFIG_DIR / "echo-yt.db"

VIDEO_ID = re.compile(r"^[\w-]{11}$")
CHANNEL_ID = re.compile(r"^UC[\w-]{22}$")
QUALITIES = (360, 480, 720, 1080, 1440, 2160)
YTDLP_TIMEOUT = 60
UPSTREAM_CHUNK = 8 * 1024 * 1024  # YouTube throttles long open-ended requests


# ---------- database ----------

SCHEMA = """
CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT, channel_id TEXT,
    duration INTEGER, view_count INTEGER, timestamp INTEGER, live INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(id),
    position INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, video_id)
);
CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, followers INTEGER, added REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
    video_id TEXT PRIMARY KEY REFERENCES videos(id),
    watched_at REAL NOT NULL, position REAL DEFAULT 0, plays INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS history_when ON history(watched_at DESC);
CREATE TABLE IF NOT EXISTS searches (query TEXT PRIMARY KEY, last_at REAL NOT NULL);
"""


class db:
    """`with db() as c:` - one connection per use, committed on success."""

    def __enter__(self):
        self.conn = sqlite3.connect(DB_PATH, timeout=10)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")
        return self.conn

    def __exit__(self, exc_type, *_):
        if exc_type is None:
            self.conn.commit()
        self.conn.close()


def init_db():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with db() as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(SCHEMA)


def upsert_video(c, v):
    if not VIDEO_ID.match(str(v.get("id", ""))):
        raise HTTPException(400, "Bad video id")
    c.execute(
        """INSERT INTO videos(id,title,channel,channel_id,duration,view_count,timestamp,live)
           VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             title=excluded.title,
             channel=COALESCE(excluded.channel,channel),
             channel_id=COALESCE(excluded.channel_id,channel_id),
             duration=COALESCE(excluded.duration,duration),
             view_count=COALESCE(excluded.view_count,view_count),
             timestamp=COALESCE(excluded.timestamp,timestamp),
             live=excluded.live""",
        (v["id"], str(v.get("title") or v["id"]), v.get("channel"), v.get("channel_id"),
         v.get("duration"), v.get("view_count"), v.get("timestamp"), 1 if v.get("live") else 0),
    )


def with_progress(videos):
    """Add each video's saved watch position, for the progress bars on cards."""
    ids = [v["id"] for v in videos]
    if not ids:
        return videos
    with db() as c:
        marks = ",".join("?" * len(ids))
        seen = {r["video_id"]: r["position"] for r in
                c.execute(f"SELECT video_id, position FROM history WHERE video_id IN ({marks})", ids)}
    for v in videos:
        v["position"] = seen.get(v["id"])
    return videos


# ---------- yt-dlp ----------

_slots = asyncio.Semaphore(6)


def ytdlp_base():
    exe = shutil.which("yt-dlp")
    if not exe:
        raise HTTPException(503, "yt-dlp is not installed")
    cmd = [exe, "--ignore-config", "--no-warnings"]
    # yt-dlp only enables deno by default, and needs a JS runtime for YouTube
    if not shutil.which("deno") and shutil.which("node"):
        cmd += ["--js-runtimes", "node"]
    return cmd


async def ytdlp_json(*args):
    """Run yt-dlp with the given arguments and return its parsed JSON output."""
    cmd = ytdlp_base() + ["-J", *args]
    async with _slots:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(), YTDLP_TIMEOUT)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise HTTPException(504, "yt-dlp took too long to answer")
        except asyncio.CancelledError:
            proc.kill()
            raise
    if proc.returncode != 0:
        lines = [l for l in err.decode(errors="replace").splitlines() if l.startswith("ERROR")]
        message = lines[-1] if lines else "yt-dlp failed"
        message = re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]{11}:\s*)?", "", message)
        raise HTTPException(502, message)
    return json.loads(out)


def clean_entry(e, channel=None):
    """One flat yt-dlp entry -> the video shape the page uses, or None."""
    vid = e.get("id") or ""
    if not VIDEO_ID.match(vid):
        return None
    return {
        "id": vid,
        "title": e.get("title") or vid,
        "channel": e.get("channel") or e.get("uploader") or (channel or {}).get("name"),
        "channel_id": e.get("channel_id") or (channel or {}).get("id"),
        "duration": int(e["duration"]) if e.get("duration") else None,
        "view_count": e.get("view_count"),
        "timestamp": e.get("timestamp"),
        "live": e.get("live_status") == "is_live",
    }


def page_args(start, count):
    start, count = max(1, start), min(max(1, count), 60)
    return start, count, ["--flat-playlist", "-I", f"{start}:{start + count - 1}"]


def channel_avatar(info):
    thumbs = info.get("thumbnails") or []
    for t in thumbs:
        if t.get("id") == "avatar_uncropped":
            return t.get("url")
    return None


async def fetch_channel(ref, start=1, count=30, approximate=False):
    args = list(page_args(start, count)[2])
    if approximate:
        args += ["--extractor-args", "youtubetab:approximate_date"]
    info = await ytdlp_json(*args, "--", f"https://www.youtube.com/channel/{ref}/videos")
    channel = {
        "id": info.get("channel_id") or ref,
        "name": info.get("channel") or info.get("uploader") or ref,
        "avatar": channel_avatar(info),
        "followers": info.get("channel_follower_count"),
    }
    videos = [v for v in (clean_entry(e, channel) for e in info.get("entries") or []) if v]
    return channel, videos


# ---------- app + request guard ----------

@asynccontextmanager
async def lifespan(app):
    init_db()
    app.state.http = httpx.AsyncClient(timeout=httpx.Timeout(30, read=60), follow_redirects=True)
    _schedule_stop(STARTUP_GRACE)  # stop if no tab ever connects (see /api/alive)
    yield
    await app.state.http.aclose()


class FreshStatic(StaticFiles):
    """The app's own scripts and styles: the browser must check they're still
    current (a cheap 304 via the ETag) instead of guessing from their age -
    otherwise after an update it can pair the new index.html with an old
    app.js. Fonts never change, so they may be cached."""

    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        if not path.startswith("fonts/"):
            resp.headers["Cache-Control"] = "no-cache"
        return resp


app = FastAPI(lifespan=lifespan)
app.mount("/static", FreshStatic(directory=STATIC_DIR), name="static")

# Only answer requests made to echo-yt itself. Checking Host stops DNS
# rebinding (another site pointing its own domain at 127.0.0.1 to read the
# API as if it were the app); checking Origin on changes stops other sites
# submitting forms to it from the browser.
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
ALLOWED_ORIGINS = {f"http://{h}" for h in ALLOWED_HOSTS}


@app.middleware("http")
async def only_from_echo_yt(request, call_next):
    if request.headers.get("host", "") not in ALLOWED_HOSTS:
        return Response("Forbidden host", status_code=403)
    origin = request.headers.get("origin")
    if request.method not in ("GET", "HEAD", "OPTIONS") and origin is not None and origin not in ALLOWED_ORIGINS:
        return Response("Forbidden origin", status_code=403)
    return await call_next(request)


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/api/status")
def status():
    runtime = shutil.which("deno") or shutil.which("node")
    return {"ytdlp": bool(shutil.which("yt-dlp")), "ffmpeg": bool(shutil.which("ffmpeg")), "js_runtime": bool(runtime)}


YTDLP_STALE_DAYS = 60  # YouTube changes often enough that this is worth a nudge


async def command_output(*cmd):
    """stdout of a quick local command, or "" if it fails."""
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            env={**os.environ, "LC_ALL": "C"})
        out, _ = await asyncio.wait_for(proc.communicate(), 15)
    except (OSError, asyncio.TimeoutError):
        return ""
    return out.decode(errors="replace") if proc.returncode == 0 else ""


def version_key(version):
    return tuple(int(n) for n in re.findall(r"\d+", version))


@app.get("/api/ytdlp")
async def ytdlp_version():
    """The installed yt-dlp, and whether pacman's last sync knows a newer one.
    Nothing here goes online; `stale` catches the case of an old sync."""
    exe = shutil.which("yt-dlp")
    if not exe:
        return {"installed": None, "available": None, "update": False, "stale": False}
    installed = (await command_output(exe, "--ignore-config", "--version")).strip() or None
    available = None
    if shutil.which("pacman"):
        m = re.search(r"^Version\s*:\s*(?:\d+:)?(\S+?)(?:-\d+)?$", await command_output("pacman", "-Si", "yt-dlp"), re.M)
        available = m.group(1) if m else None
    update = bool(installed and available and version_key(available) > version_key(installed))
    stale = False
    m = re.match(r"(\d{4})\.(\d{1,2})\.(\d{1,2})", installed or "")
    if m:
        try:
            released = datetime(*map(int, m.groups()))
            stale = (datetime.now() - released).days > YTDLP_STALE_DAYS
        except ValueError:
            pass
    return {"installed": installed, "available": available, "update": update, "stale": stale}


# ---------- search ----------

def classify_url(text):
    """Is this a YouTube link? Returns (kind, value) or None for a plain query."""
    if not re.match(r"^(https?://|(www\.|m\.|music\.)?youtube\.com/|youtu\.be/)", text, re.I):
        return None
    url = text if text.lower().startswith("http") else "https://" + text
    m = re.match(r"^https?://([^/]+)(/[^?#]*)?(\?[^#]*)?", url)
    host = (m.group(1) if m else "").lower().removeprefix("www.").removeprefix("m.").removeprefix("music.")
    path = (m.group(2) or "") if m else ""
    query = (m.group(3) or "") if m else ""
    if host == "youtu.be":
        return "video", path.strip("/")[:11]
    if host != "youtube.com":
        return "unsupported", url
    v = re.search(r"[?&]v=([\w-]{11})", query)
    if v:
        return "video", v.group(1)
    short = re.match(r"^/(shorts|live|embed)/([\w-]{11})", path)
    if short:
        return "video", short.group(2)
    if path.startswith("/playlist"):
        return "list", url
    uc = re.match(r"^/channel/(UC[\w-]{22})", path)
    if uc:
        return "channel", uc.group(1)
    return "channel_lookup", url


@app.get("/api/search")
async def search(q: str, start: int = 1, count: int = 24):
    q = q.strip()
    if not q:
        return {"kind": "results", "videos": []}
    link = classify_url(q)
    if link:
        kind, value = link
        if kind in ("video", "channel"):
            return {"kind": kind, "id": value}
        if kind == "unsupported":
            raise HTTPException(400, "echo-yt only understands YouTube links")
        args = page_args(start, count)[2]
        info = await ytdlp_json(*args, "--", value)
        if kind == "channel_lookup":
            if not CHANNEL_ID.match(info.get("channel_id") or ""):
                raise HTTPException(404, "Couldn't find a channel at that link")
            return {"kind": "channel", "id": info["channel_id"]}
        videos = [v for v in (clean_entry(e) for e in info.get("entries") or []) if v]
        return {"kind": "results", "videos": with_progress(videos), "more": False}

    first, n, args = page_args(start, count)
    info = await ytdlp_json(*args, "--", f"ytsearch{first + n - 1}:{q}")
    videos = [v for v in (clean_entry(e) for e in info.get("entries") or []) if v]
    if first == 1:
        with db() as c:
            c.execute("INSERT INTO searches(query,last_at) VALUES(?,?) "
                      "ON CONFLICT(query) DO UPDATE SET last_at=excluded.last_at", (q, time.time()))
            c.execute("DELETE FROM searches WHERE query NOT IN (SELECT query FROM searches ORDER BY last_at DESC LIMIT 100)")
    return {"kind": "results", "videos": with_progress(videos), "more": len(videos) >= n}


@app.get("/api/searches")
def recent_searches():
    with db() as c:
        return [r["query"] for r in c.execute("SELECT query FROM searches ORDER BY last_at DESC LIMIT 12")]


@app.delete("/api/searches")
def forget_searches(q: str | None = None):
    with db() as c:
        if q is None:
            c.execute("DELETE FROM searches")
        else:
            c.execute("DELETE FROM searches WHERE query=?", (q,))
    return {"ok": True}


# ---------- channels ----------

@app.get("/api/channel/{ref}")
async def channel_page(ref: str, start: int = 1, count: int = 30):
    if not CHANNEL_ID.match(ref):
        raise HTTPException(400, "Bad channel id")
    channel, videos = await fetch_channel(ref, start, count, approximate=True)
    with db() as c:
        saved = c.execute("SELECT 1 FROM channels WHERE id=?", (channel["id"],)).fetchone() is not None
        if saved and channel["avatar"]:  # keep saved channels' details fresh
            c.execute("UPDATE channels SET name=?, avatar=?, followers=? WHERE id=?",
                      (channel["name"], channel["avatar"], channel["followers"], channel["id"]))
    return {"channel": {**channel, "saved": saved}, "videos": with_progress(videos), "more": len(videos) >= count}


@app.get("/api/channels")
def list_channels():
    with db() as c:
        return [dict(r) for r in c.execute("SELECT * FROM channels ORDER BY name COLLATE NOCASE")]


@app.post("/api/channels/{ref}")
async def save_channel(ref: str):
    if not CHANNEL_ID.match(ref):
        raise HTTPException(400, "Bad channel id")
    channel, _ = await fetch_channel(ref, 1, 1)
    with db() as c:
        c.execute("INSERT OR REPLACE INTO channels(id,name,avatar,followers,added) VALUES(?,?,?,?,?)",
                  (ref, channel["name"], channel["avatar"], channel["followers"], time.time()))
    _feed_cache.clear()
    return {**channel, "saved": True}


@app.delete("/api/channels/{ref}")
def forget_channel(ref: str):
    with db() as c:
        c.execute("DELETE FROM channels WHERE id=?", (ref,))
    _feed_cache.clear()
    return {"ok": True}


_feed_cache = {}
FEED_TTL = 15 * 60


@app.get("/api/feed")
async def feed(refresh: bool = False):
    """The newest uploads across every saved channel."""
    with db() as c:
        channels = [r["id"] for r in c.execute("SELECT id FROM channels")]
    if not channels:
        return {"videos": [], "failed": 0}
    cached = _feed_cache.get("feed")
    if cached and not refresh and time.time() - cached[0] < FEED_TTL:
        return {**cached[1], "videos": with_progress(cached[1]["videos"])}
    results = await asyncio.gather(*(fetch_channel(ref, 1, 12, approximate=True) for ref in channels),
                                   return_exceptions=True)
    videos, failed = [], 0
    for r in results:
        if isinstance(r, BaseException):
            failed += 1
        else:
            videos += r[1]
    videos.sort(key=lambda v: v.get("timestamp") or 0, reverse=True)
    data = {"videos": videos[:60], "failed": failed}
    if not failed:
        _feed_cache["feed"] = (time.time(), data)
    return {**data, "videos": with_progress(data["videos"])}


# ---------- playback ----------
# Pages get opaque /stream/<token> addresses; a token can only ever point at a
# media URL yt-dlp returned, so the relay can't be aimed at anything else.

_streams = {}   # token -> {url, headers, mime, born}
_resolved = {}  # video id -> (time, info)
RESOLVE_TTL = 30 * 60
STREAM_TTL = 6 * 3600


def stream_token(fmt):
    now = time.time()
    for token in [t for t, s in _streams.items() if now - s["born"] > STREAM_TTL]:
        del _streams[token]
    token = secrets.token_urlsafe(16)
    ext = fmt.get("ext") or "mp4"
    kind = "audio" if fmt.get("vcodec") in (None, "none") else "video"
    _streams[token] = {"url": fmt["url"], "headers": fmt.get("http_headers") or {},
                       "mime": f"{kind}/{'mp4' if ext == 'm4a' else ext}", "born": now}
    return token


def rank_video(f):
    # VP9 plays in every browser, unlike H.264 on some Linux builds; AV1 is
    # heavy to decode in software, so it comes last
    codec = f.get("vcodec") or ""
    order = 2 if codec.startswith("vp9") else 1 if codec.startswith("avc1") else 0
    return (f.get("height") or 0, order, f.get("fps") or 0, f.get("tbr") or 0)


def pick_sources(info, quality):
    formats = [f for f in info.get("formats") or [] if f.get("url") and not f.get("has_drm")]
    direct = [f for f in formats if f.get("protocol") == "https"]
    video_only = [f for f in direct if f.get("vcodec") not in (None, "none") and f.get("acodec") in (None, "none")
                  and (f.get("vcodec") or "")[:4] in ("vp9", "vp09", "avc1", "av01") and f.get("height")]
    audio_only = [f for f in direct if f.get("vcodec") in (None, "none") and f.get("acodec") not in (None, "none")]
    muxed = [f for f in direct if f.get("vcodec") not in (None, "none") and f.get("acodec") not in (None, "none")]
    hls = [f for f in formats if str(f.get("protocol", "")).startswith("m3u8")
           and f.get("vcodec") not in (None, "none") and (f.get("vcodec") or "").startswith("avc1")]

    if info.get("live_status") == "is_live" or (not video_only and not muxed):
        if not hls:
            raise HTTPException(502, "No playable stream for this video")
        heights = sorted({f.get("height") or 0 for f in hls})
        wanted = [f for f in hls if (f.get("height") or 0) <= quality] or hls
        best = max(wanted, key=lambda f: ((f.get("height") or 0), f.get("tbr") or 0))
        return {"mode": "live", "src": f"/live/{stream_token(best)}", "height": best.get("height"),
                "heights": [h for h in heights if h in QUALITIES]}

    heights = sorted({f["height"] for f in video_only if f["height"] in QUALITIES}, reverse=False)
    fallback = None
    if muxed:
        m = max(muxed, key=lambda f: f.get("height") or 0)
        fallback = {"mode": "single", "src": f"/stream/{stream_token(m)}", "height": m.get("height")}
    if not video_only or not audio_only:
        if not fallback:
            raise HTTPException(502, "No playable stream for this video")
        return {**fallback, "heights": [fallback["height"]]}

    wanted = [f for f in video_only if f["height"] <= quality] or video_only
    video = max(wanted, key=rank_video)
    opus = [f for f in audio_only if f.get("acodec") == "opus"]
    aac = [f for f in audio_only if str(f.get("acodec")).startswith("mp4a")]
    # same container as the video when we can; only the ordinary (not dubbed,
    # not "drc") track - yt-dlp's preference puts the original language first
    pool = (opus if video.get("ext") == "webm" else aac) or audio_only
    original = [f for f in pool if (f.get("language_preference") or -1) >= (max(g.get("language_preference") or -1 for g in pool))]
    audio = max([f for f in original if "drc" not in str(f.get("format_id"))] or original, key=lambda f: f.get("tbr") or 0)
    return {"mode": "split", "video": f"/stream/{stream_token(video)}", "audio": f"/stream/{stream_token(audio)}",
            "height": video["height"], "heights": heights, "fallback": fallback}


@app.get("/api/video/{vid}")
async def video_details(vid: str, quality: int = 1080, refresh: bool = False):
    if not VIDEO_ID.match(vid):
        raise HTTPException(400, "Bad video id")
    cached = _resolved.get(vid)
    if cached and not refresh and time.time() - cached[0] < RESOLVE_TTL:
        info = cached[1]
    else:
        info = await ytdlp_json("--no-playlist", "--", f"https://www.youtube.com/watch?v={vid}")
        _resolved[vid] = (time.time(), info)
        for old in [k for k, (t, _) in _resolved.items() if time.time() - t > RESOLVE_TTL]:
            del _resolved[old]
    video = clean_entry(info)
    if not video:
        raise HTTPException(502, "yt-dlp returned an unexpected result")
    with db() as c:
        row = c.execute("SELECT position FROM history WHERE video_id=?", (vid,)).fetchone()
        saved = c.execute("SELECT 1 FROM channels WHERE id=?", (video["channel_id"],)).fetchone() is not None
    return {
        **video,
        "position": row["position"] if row else None,
        "channel_saved": saved,
        "description": info.get("description") or "",
        "like_count": info.get("like_count"),
        "upload_date": info.get("upload_date"),
        "followers": info.get("channel_follower_count"),
        "chapters": [{"start": c.get("start_time"), "title": c.get("title")} for c in info.get("chapters") or []],
        "sources": pick_sources(info, quality),
    }


def parse_range(header):
    m = re.match(r"bytes=(\d+)-(\d*)", header or "")
    if not m:
        return 0, None
    return int(m.group(1)), int(m.group(2)) if m.group(2) else None


@app.get("/stream/{token}")
async def relay(token: str, request: Request):
    """Serve a media URL to the player, in YouTube-sized chunks."""
    item = _streams.get(token)
    if not item:
        raise HTTPException(404, "Stream expired")
    client = request.app.state.http
    start, end = parse_range(request.headers.get("range"))

    async def open_chunk(first):
        last = first + UPSTREAM_CHUNK - 1
        if end is not None:
            last = min(last, end)
        headers = {**item["headers"], "Range": f"bytes={first}-{last}"}
        # A freshly extracted address answers 403 for its first second or so
        for wait in (0.5, 1, 1.5, 2, None):
            resp = await client.send(client.build_request("GET", item["url"], headers=headers), stream=True)
            if resp.status_code != 403 or wait is None:
                return resp
            await resp.aclose()
            await asyncio.sleep(wait)

    try:
        upstream = await open_chunk(start)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Upstream error: {e}")
    if upstream.status_code not in (200, 206):
        code = upstream.status_code
        await upstream.aclose()
        # 416 passes through so a seek past the end fails normally
        raise HTTPException(416 if code == 416 else 502, f"Upstream returned {code}")

    m = re.search(r"/(\d+)$", upstream.headers.get("content-range", ""))
    total = int(m.group(1)) if m else int(upstream.headers.get("content-length", 0))
    final = min(end, total - 1) if end is not None else total - 1

    async def body():
        current = upstream
        position = start
        try:
            while True:
                async for block in current.aiter_bytes(64 * 1024):
                    position += len(block)
                    yield block
                await current.aclose()
                if position > final:
                    return
                current = await open_chunk(position)
                if current.status_code not in (200, 206):
                    return  # the browser retries with a Range request of its own
        finally:
            await current.aclose()

    return StreamingResponse(body(), status_code=206, media_type=item["mime"], headers={
        "Accept-Ranges": "bytes",
        "Content-Range": f"bytes {start}-{final}/{total}",
        "Content-Length": str(final - start + 1),
        "Cache-Control": "no-store",
    })


@app.get("/live/{token}")
async def live(token: str):
    """Live streams are HLS, which browsers can't play; ffmpeg rewraps it as MP4."""
    item = _streams.get(token)
    if not item:
        raise HTTPException(404, "Stream expired")
    if not shutil.which("ffmpeg"):
        raise HTTPException(503, "ffmpeg is needed for live streams")
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-loglevel", "error", "-i", item["url"], "-c", "copy",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, stdin=asyncio.subprocess.DEVNULL)

    async def body():
        try:
            while block := await proc.stdout.read(64 * 1024):
                yield block
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()

    return StreamingResponse(body(), media_type="video/mp4", headers={"Cache-Control": "no-store"})


# ---------- history ----------

VIDEO_COLS = "v.id, v.title, v.channel, v.channel_id, v.duration, v.view_count, v.timestamp, v.live"


@app.get("/api/history")
def history(q: str = "", limit: int = 60, offset: int = 0):
    like = f"%{q.strip()}%"
    with db() as c:
        rows = c.execute(
            f"""SELECT {VIDEO_COLS}, h.watched_at, h.position, h.plays
                FROM history h JOIN videos v ON v.id=h.video_id
                WHERE v.title LIKE ? OR v.channel LIKE ?
                ORDER BY h.watched_at DESC LIMIT ? OFFSET ?""",
            (like, like, min(limit, 200) + 1, max(offset, 0))).fetchall()
    return {"videos": [dict(r) for r in rows[:limit]], "more": len(rows) > limit}


@app.post("/api/history")
def record_play(video: dict = Body(...)):
    with db() as c:
        upsert_video(c, video)
        c.execute("""INSERT INTO history(video_id,watched_at,position) VALUES(?,?,0)
                     ON CONFLICT(video_id) DO UPDATE SET watched_at=excluded.watched_at, plays=plays+1""",
                  (video["id"], time.time()))
    return {"ok": True}


@app.post("/api/history/{vid}/position")
def save_position(vid: str, body: dict = Body(...)):
    with db() as c:
        c.execute("UPDATE history SET position=? WHERE video_id=?", (float(body.get("position") or 0), vid))
    return {"ok": True}


@app.delete("/api/history/{vid}")
def forget_watch(vid: str):
    with db() as c:
        c.execute("DELETE FROM history WHERE video_id=?", (vid,))
    return {"ok": True}


@app.delete("/api/history")
def clear_history():
    with db() as c:
        c.execute("DELETE FROM history")
    return {"ok": True}


# ---------- playlists ----------

def playlist_or_404(c, pid):
    row = c.execute("SELECT * FROM playlists WHERE id=?", (pid,)).fetchone()
    if not row:
        raise HTTPException(404, "No such playlist")
    return dict(row)


def clean_name(body):
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "A playlist needs a name")
    return name[:120]


@app.get("/api/playlists")
def list_playlists():
    with db() as c:
        rows = c.execute(
            """SELECT p.id, p.name, p.updated, COUNT(i.video_id) AS count,
                      COALESCE(SUM(v.duration),0) AS seconds,
                      (SELECT video_id FROM playlist_items WHERE playlist_id=p.id ORDER BY position LIMIT 1) AS cover
               FROM playlists p
               LEFT JOIN playlist_items i ON i.playlist_id=p.id
               LEFT JOIN videos v ON v.id=i.video_id
               GROUP BY p.id ORDER BY p.updated DESC""").fetchall()
    return [dict(r) for r in rows]


@app.post("/api/playlists")
def create_playlist(body: dict = Body(...)):
    now = time.time()
    with db() as c:
        cur = c.execute("INSERT INTO playlists(name,created,updated) VALUES(?,?,?)", (clean_name(body), now, now))
        return {"id": cur.lastrowid, "name": clean_name(body)}


@app.get("/api/playlists/{pid}")
def get_playlist(pid: int):
    with db() as c:
        playlist = playlist_or_404(c, pid)
        rows = c.execute(
            f"""SELECT {VIDEO_COLS}, h.position FROM playlist_items i
                JOIN videos v ON v.id=i.video_id
                LEFT JOIN history h ON h.video_id=v.id
                WHERE i.playlist_id=? ORDER BY i.position""", (pid,)).fetchall()
    return {**playlist, "videos": [dict(r) for r in rows]}


@app.patch("/api/playlists/{pid}")
def rename_playlist(pid: int, body: dict = Body(...)):
    with db() as c:
        playlist_or_404(c, pid)
        c.execute("UPDATE playlists SET name=?, updated=? WHERE id=?", (clean_name(body), time.time(), pid))
    return {"ok": True}


@app.delete("/api/playlists/{pid}")
def delete_playlist(pid: int):
    with db() as c:
        c.execute("DELETE FROM playlists WHERE id=?", (pid,))
    return {"ok": True}


@app.post("/api/playlists/{pid}/items")
def add_to_playlist(pid: int, video: dict = Body(...)):
    with db() as c:
        playlist_or_404(c, pid)
        upsert_video(c, video)
        c.execute("""INSERT OR IGNORE INTO playlist_items(playlist_id,video_id,position)
                     VALUES(?,?,(SELECT COALESCE(MAX(position),0)+1 FROM playlist_items WHERE playlist_id=?))""",
                  (pid, video["id"], pid))
        c.execute("UPDATE playlists SET updated=? WHERE id=?", (time.time(), pid))
    return {"ok": True}


@app.delete("/api/playlists/{pid}/items/{vid}")
def remove_from_playlist(pid: int, vid: str):
    with db() as c:
        c.execute("DELETE FROM playlist_items WHERE playlist_id=? AND video_id=?", (pid, vid))
        c.execute("UPDATE playlists SET updated=? WHERE id=?", (time.time(), pid))
    return {"ok": True}


@app.put("/api/playlists/{pid}/order")
def reorder_playlist(pid: int, body: dict = Body(...)):
    with db() as c:
        playlist_or_404(c, pid)
        for i, vid in enumerate(body.get("ids") or []):
            c.execute("UPDATE playlist_items SET position=? WHERE playlist_id=? AND video_id=?", (i, pid, vid))
        c.execute("UPDATE playlists SET updated=? WHERE id=?", (time.time(), pid))
    return {"ok": True}


@app.get("/api/video/{vid}/playlists")
def playlists_holding(vid: str):
    with db() as c:
        return [r["playlist_id"] for r in c.execute("SELECT playlist_id FROM playlist_items WHERE video_id=?", (vid,))]


# ---------- stop when the last tab closes (only when started from the app menu) ----------
# Every open echo-yt page holds a /api/alive connection. When echo-yt --open
# starts the server it sets ECHO_YT_AUTO_STOP=1, and the server then shuts
# itself down once no page has been connected for STOP_GRACE seconds (long
# enough to survive a reload), or if no page connects at all after startup.

# systemd socket activation: systemd listens on the port while the app isn't
# running and starts it on the first connection, handing over the listening
# socket as fd 3 (LISTEN_FDS/LISTEN_PID, see sd_listen_fds(3)). Started that
# way it always stops itself when idle - the next visit starts it again.
SD_LISTEN_FD = 3
SOCKET_ACTIVATED = (os.environ.get("LISTEN_PID") == str(os.getpid())
                    and int(os.environ.get("LISTEN_FDS", "0") or 0) >= 1)

AUTO_STOP = os.environ.get("ECHO_YT_AUTO_STOP") == "1" or SOCKET_ACTIVATED
STOP_GRACE = 10
STARTUP_GRACE = 60
_open_pages = 0
_stop_task = None

# Changes whenever the app's code does. Sent down /api/alive, so a page left
# open across an update reloads itself instead of running the old code
# against the new server.
APP_VERSION = hashlib.sha256(b"".join(
    p.read_bytes() for p in sorted([Path(__file__), *STATIC_DIR.rglob("*")]) if p.is_file()
)).hexdigest()[:16]


def _schedule_stop(delay: float):
    global _stop_task
    if not AUTO_STOP:
        return
    if _stop_task is not None:
        _stop_task.cancel()

    async def stop_later():
        await asyncio.sleep(delay)
        if _open_pages == 0:
            print("No echo-yt tab open - stopping.", flush=True)
            os.kill(os.getpid(), signal.SIGINT)  # uvicorn's normal, graceful shutdown

    _stop_task = asyncio.get_running_loop().create_task(stop_later())


@app.get("/api/alive")
async def api_alive():
    async def stream():
        global _open_pages
        _open_pages += 1
        if _stop_task is not None:
            _stop_task.cancel()
        try:
            yield f"retry: 2000\nevent: version\ndata: {APP_VERSION}\n\n"
            while True:
                await asyncio.sleep(15)
                yield ": keepalive\n\n"
        finally:
            _open_pages -= 1
            if _open_pages == 0:
                _schedule_stop(STOP_GRACE)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    if AUTO_STOP:
        print("Stops automatically once no echo-yt tab is open.", flush=True)
    # Open pages hold a never-ending /api/alive stream, so don't wait for
    # connections to finish on shutdown (Ctrl-C) - just close them.
    if SOCKET_ACTIVATED:
        # serve on the socket systemd is already listening on; the waiting
        # first request (the one that started us) is answered from it
        sock = socket.socket(fileno=SD_LISTEN_FD)
        for k in ("LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"):
            os.environ.pop(k, None)  # not meant for child processes
        print(f"Started on demand by systemd at http://127.0.0.1:{PORT}", flush=True)
        try:
            uvicorn.Server(uvicorn.Config(app, timeout_graceful_shutdown=3)).run(sockets=[sock])
        except KeyboardInterrupt:  # the auto-stop's SIGINT, re-raised after a clean shutdown
            pass
    else:
        uvicorn.run(app, host="127.0.0.1", port=PORT, timeout_graceful_shutdown=3)

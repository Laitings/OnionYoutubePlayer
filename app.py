"""Onion Player: a local YouTube Music player.

ytmusicapi reads your library and playlists, yt-dlp finds the audio stream,
and this server hands that audio to the browser. It only listens on
127.0.0.1, because it uses your YouTube login.
"""
import json
import mimetypes
import os
import queue
import random
import re
import shutil
import sys
import threading
import time
from pathlib import Path

import httpx
import yt_dlp
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from ytmusicapi import YTMusic
from ytmusicapi.auth.browser import setup_browser

BASE = Path(__file__).parent

# Started without a console window (pythonw, see "Onion Player.vbs")? Then there is nowhere to print,
# so write to a log file instead. This also keeps the web server from crashing on a missing console.
if sys.stdout is None or sys.stderr is None:
    _log = open(BASE / "onion.log", "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stdout or _log
    sys.stderr = sys.stderr or _log
    print(f"--- started {time.strftime('%Y-%m-%d %H:%M:%S')}")

mimetypes.add_type("application/manifest+json", ".webmanifest")
AUTH_FILE = BASE / "browser.json"            # ytmusicapi login, created from the setup screen
AUTO_COOKIES = BASE / "cookies.auto.txt"     # same login, converted for yt-dlp
MANUAL_COOKIES = BASE / "cookies.txt"        # optional: your own exported cookies, wins over the above
CONFIG_FILE = BASE / "config.json"           # optional settings, see README
CACHE_DIR = BASE / "cache"
CACHE_DIR.mkdir(exist_ok=True)

STREAM_TTL = 90 * 60          # resolved stream URLs live for hours, we reuse them for 90 minutes
PORT = int(os.environ.get("ONION_PORT", "8765"))

app = FastAPI(title="Onion Player")


# ---------------------------------------------------------------- helpers

def load_config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def safe_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value):
        raise HTTPException(400, "Bad id")
    return value


def api_error(exc: Exception, account_level: bool = False) -> HTTPException:
    """Only a failure of an account-wide request means the login is bad. A single playlist can fail
    for its own reasons (removed, podcast, no access), and must not send you back to the login screen."""
    msg = str(exc)
    if account_level and (any(code in msg for code in ("401", "403")) or "authentication" in msg.lower()):
        return HTTPException(401, "YouTube Music rejected the saved login. Paste fresh headers.")
    return HTTPException(502, msg[:300] or exc.__class__.__name__)


@app.middleware("http")
async def only_local_hosts(request: Request, call_next):
    # Blocks DNS-rebinding tricks: only answer requests addressed to this computer.
    host = request.headers.get("host", "").rsplit(":", 1)[0].strip("[]")
    if host not in ("127.0.0.1", "localhost", "::1"):
        return PlainTextResponse("Forbidden", status_code=403)
    return await call_next(request)


# ---------------------------------------------------------------- YouTube Music side

_yt: YTMusic | None = None
_yt_lock = threading.Lock()


def get_yt() -> YTMusic:
    global _yt
    if _yt is None:
        if not AUTH_FILE.exists():
            raise HTTPException(401, "Not connected to YouTube Music yet.")
        _yt = YTMusic(str(AUTH_FILE))
    return _yt


def artist_list(artists) -> list[dict]:
    """[{name, id}] for the artists of a song. The id is what the artist page needs (some songs have none)."""
    out = []
    for x in artists or []:
        if isinstance(x, dict) and x.get("name"):
            out.append({"name": x["name"], "id": x.get("id")})
    return out


def simplify(t: dict) -> dict:
    thumbs = t.get("thumbnails") or []
    album = t.get("album") or {}
    video_id = t.get("videoId")
    return {
        "id": video_id,
        "title": t.get("title") or "",
        "artists": ", ".join(a["name"] for a in (t.get("artists") or []) if a.get("name")),
        "artistList": artist_list(t.get("artists")),
        "album": album.get("name") or "",
        "albumId": album.get("id"),
        "duration": t.get("duration_seconds") or 0,
        "art": thumbs[-1]["url"] if thumbs else None,
        "ok": bool(video_id) and t.get("isAvailable", True) is not False,
        "type": t.get("videoType"),
        "sid": t.get("setVideoId"),   # this song's entry in the playlist; YouTube needs it to remove the song
    }


def cache_path(name: str) -> Path:
    return CACHE_DIR / f"{name}.json"


def read_cache(name: str):
    try:
        return json.loads(cache_path(name).read_text("utf-8"))
    except (OSError, ValueError):
        return None


def write_cache(name: str, data) -> None:
    tmp = cache_path(name).with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    tmp.replace(cache_path(name))


def fetch_playlists() -> dict:
    yt = get_yt()
    with _yt_lock:
        items = yt.get_library_playlists(limit=None)
    out = [{"id": "LM", "title": "Liked songs", "count": None}]
    seen = {"LM", "SE", "RDPN"}   # SE = "Episodes for later", RDPN = "New Episodes": podcasts, not music
    for p in items:
        pid = p.get("playlistId")
        if not pid or pid in seen:
            continue
        seen.add(pid)
        out.append({"id": pid, "title": p.get("title") or "Untitled", "count": p.get("count")})
    return {"playlists": out, "fetched": int(time.time())}


def is_album(pid: str) -> bool:
    return pid.startswith("MPRE")   # album browse ids look like MPREb_…


def fetch_album(bid: str) -> dict:
    """An album, shaped like a playlist, so the page can open it the same way."""
    yt = get_yt()
    with _yt_lock:
        a = yt.get_album(bid)
    now = int(time.time())
    thumbs = a.get("thumbnails") or []
    art = thumbs[-1]["url"] if thumbs else None
    title = a.get("title") or "Album"
    names = lambda lst: ", ".join(x["name"] for x in (lst or []) if x.get("name"))
    tracks = []
    for t in a.get("tracks") or []:
        vid = t.get("videoId")
        tracks.append({
            "id": vid,
            "title": t.get("title") or "",
            "artists": names(t.get("artists")) or names(a.get("artists")),
            "artistList": artist_list(t.get("artists")) or artist_list(a.get("artists")),
            "album": title,
            "albumId": bid,
            "duration": t.get("duration_seconds") or 0,
            "art": art,
            "ok": bool(vid) and t.get("isAvailable", True) is not False,
            "type": t.get("videoType"),
            "sid": None,
        })
    artists = names(a.get("artists"))
    year = str(a.get("year") or "")
    byline = " · ".join(x for x in (artists, year) if x)
    seconds = sum(t["duration"] for t in tracks)
    return {
        "id": bid, "title": title, "byline": byline, "fetched": now, "checked": now, "count": len(tracks), "tracks": tracks,
        # what the album page shows above the songs
        "album": {
            "type": a.get("type") or "Album",       # Album, EP, Single
            "artists": artists,
            "artistList": artist_list(a.get("artists")),
            "year": year,
            "cover": art,
            "seconds": seconds,
            "explicit": bool(a.get("isExplicit")),
            "description": (a.get("description") or "")[:1200],
            "playlistId": a.get("audioPlaylistId"),   # what YouTube Music needs to add the album to your library
        },
    }


def is_artist(pid: str) -> bool:
    return pid.startswith("UC") or pid.startswith("MPLA")


def fetch_artist(cid: str) -> dict:
    """An artist page: top songs, albums, singles and similar artists. Songs are shaped like a playlist's."""
    yt = get_yt()
    with _yt_lock:
        a = yt.get_artist(cid)
    now = int(time.time())

    def thumb(x):
        th = (x or {}).get("thumbnails") or []
        return th[-1]["url"] if th else None

    def releases(section: str) -> list[dict]:
        sec = a.get(section) or {}
        items = sec.get("results") or []
        if sec.get("browseId") and sec.get("params"):   # the page only shows a few: ask for all of them
            try:
                with _yt_lock:
                    items = yt.get_artist_albums(sec["browseId"], sec["params"], limit=None) or items
            except Exception as exc:
                print(f"artist {section} list failed: {exc.__class__.__name__}: {str(exc)[:200]}")
        return [{"id": i["browseId"], "title": i.get("title") or "", "year": str(i.get("year") or ""),
                 "type": i.get("type") or ("Single" if section == "singles" else "Album"), "art": thumb(i)}
                for i in items if i.get("browseId")]

    name = a.get("name") or "Artist"
    songs = a.get("songs") or {}
    tracks = []
    if songs.get("browseId"):   # the full song list is a playlist: take its first 50 (with durations)
        try:
            pl_id = songs["browseId"].removeprefix("VL")
            with _yt_lock:
                tracks = [simplify(t) for t in (yt.get_playlist(pl_id, limit=50).get("tracks") or [])]
        except Exception as exc:
            print(f"artist songs list failed: {exc.__class__.__name__}: {str(exc)[:200]}")
    if not tracks:
        for t in songs.get("results") or []:
            vid = t.get("videoId")
            al = t.get("album")
            tracks.append({
                "id": vid, "title": t.get("title") or "", "artists": name, "artistList": [{"name": name, "id": cid}],
                "album": (al.get("name") if isinstance(al, dict) else al) or "", "albumId": al.get("id") if isinstance(al, dict) else None,
                "duration": t.get("duration_seconds") or 0, "art": thumb(t), "ok": bool(vid), "type": None, "sid": None,
            })
    stats = " · ".join(x for x in (
        (a.get("subscribers") + " subscribers") if a.get("subscribers") else "",
        (a.get("monthlyListeners") + " monthly listeners") if a.get("monthlyListeners") else "") if x)
    return {
        "id": cid, "title": name, "fetched": now, "checked": now, "count": len(tracks), "tracks": tracks,
        "artist": {
            "name": name, "stats": stats, "views": a.get("views") or "", "image": thumb(a),
            "description": (a.get("description") or "")[:1500],
            "albums": releases("albums"), "singles": releases("singles"),
            "related": [{"id": r["browseId"], "title": r.get("title") or "", "subscribers": r.get("subscribers") or "", "art": thumb(r)}
                        for r in (a.get("related") or {}).get("results") or [] if r.get("browseId")],
        },
    }


def fetch_playlist(pid: str, cached: dict | None = None) -> dict:
    """Downloads a playlist. With a saved copy, first asks for just the first page (one request):
    if the song count and the first songs are the same, the saved copy is kept."""
    yt = get_yt()
    now = int(time.time())
    if cached and cached.get("count") is not None:
        try:
            with _yt_lock:
                head = yt.get_playlist(pid, limit=0)   # limit=0: first page only, no follow-up requests
            ids = [t.get("videoId") for t in head.get("tracks") or []]
            if head.get("trackCount") == cached["count"] and ids == [t["id"] for t in cached["tracks"][:len(ids)]]:
                return {**cached, "checked": now}
        except Exception:
            pass   # anything odd: fall through to a full download
    with _yt_lock:
        data = yt.get_playlist(pid, limit=None)
    return {
        "id": pid,
        "title": "Liked songs" if pid == "LM" else (data.get("title") or "Playlist"),
        "fetched": now,
        "checked": now,
        "count": data.get("trackCount"),
        "tracks": [simplify(t) for t in data.get("tracks") or []],
    }


@app.get("/api/status")
def status():
    return {"authenticated": AUTH_FILE.exists()}


class SetupBody(BaseModel):
    headers: str


def curl_to_headers(text: str) -> str:
    """Turns 'Copy as cURL (bash)' from Chrome/Edge into plain 'name: value' header lines."""
    lines = [m.group(1) for m in re.finditer(r"(?:-H|--header)\s+'([^']*)'", text)]
    cookie = re.search(r"(?:-b|--cookie)\s+'([^']*)'", text)
    if cookie:
        lines.append("cookie: " + cookie.group(1))
    return "\n".join(lines)


@app.post("/api/setup")
def setup(body: SetupBody):
    global _yt
    raw = body.headers.strip()
    if raw.lower().startswith("curl"):
        raw = curl_to_headers(raw.replace("\\\r\n", " ").replace("\\\n", " "))
    try:
        setup_browser(filepath=str(AUTH_FILE), headers_raw=raw)
    except Exception as exc:
        raise HTTPException(400, str(exc)[:400])
    _yt = None
    try:
        with _yt_lock:
            get_yt().get_library_playlists(limit=1)
    except Exception as exc:
        AUTH_FILE.unlink(missing_ok=True)
        _yt = None
        raise HTTPException(400, "YouTube Music did not accept those headers. Make sure you were signed in "
                                 "and copied a request to music.youtube.com. (" + str(exc)[:160] + ")")
    # Reuse the same login for yt-dlp, so playback runs as your Premium account.
    try:
        cookie = next(v for k, v in json.loads(AUTH_FILE.read_text("utf-8")).items() if k.lower() == "cookie")
        write_auto_cookies(cookie)
    except Exception:
        pass
    return {"ok": True}


def write_auto_cookies(cookie_header: str) -> None:
    expiry = int(time.time()) + 365 * 24 * 3600
    lines = ["# Netscape HTTP Cookie File"]
    for part in cookie_header.split(";"):
        name, sep, value = part.strip().partition("=")
        if sep and name:
            lines.append(f".youtube.com\tTRUE\t/\tTRUE\t{expiry}\t{name}\t{value}")
    AUTO_COOKIES.write_text("\n".join(lines) + "\n", "utf-8")


def synced_times(items: list[dict]) -> dict:
    """When each playlist was last saved or checked, from the cache files' timestamps."""
    out = {}
    for p in items:
        try:
            out[p["id"]] = int(cache_path(p["id"]).stat().st_mtime)
        except OSError:
            pass
    return out


@app.get("/api/playlists")
def playlists(refresh: int = 0):
    if not refresh:
        cached = read_cache("_playlists")
        if cached:
            return {**cached, "cached": True, "synced": synced_times(cached["playlists"])}
    try:
        data = fetch_playlists()
    except HTTPException:
        raise
    except Exception as exc:
        raise api_error(exc, account_level=True)
    write_cache("_playlists", data)
    return {**data, "cached": False, "synced": synced_times(data["playlists"])}


@app.get("/api/playlist/{pid}")
def playlist(pid: str, refresh: int = 0, full: int = 0):
    """No flags: the saved copy if there is one. refresh=1: check for changes (one request when
    nothing changed). full=1 as well: download everything again."""
    safe_id(pid)
    cached = read_cache(pid)
    if cached and is_album(pid) and "playlistId" not in (cached.get("album") or {}):
        cached = None   # saved by an older version, without the details the album page needs
    if cached and not refresh:
        return {**cached, "cached": True}
    if cached and is_album(pid) and not full:
        return {**cached, "checked": int(time.time()), "cached": False}   # albums don't change
    if cached and is_artist(pid) and not full and time.time() - cached.get("fetched", 0) < 7 * 24 * 3600:
        return {**cached, "checked": int(time.time()), "cached": False}   # artist pages: look again after a week
    try:
        data = fetch_album(pid) if is_album(pid) else fetch_artist(pid) if is_artist(pid) else fetch_playlist(pid, None if full else cached)
    except HTTPException:
        raise
    except Exception as exc:
        raise api_error(exc)
    write_cache(pid, data)
    return {**data, "cached": False}


@app.get("/api/cached")
def all_cached():
    """Every playlist already synced to disk, for searching across all of them."""
    listing = (read_cache("_playlists") or {}).get("playlists") or []
    out = []
    for p in listing:
        data = read_cache(p["id"])
        if data and data.get("tracks"):
            out.append({"id": p["id"], "title": data.get("title") or p["title"], "tracks": data["tracks"]})
    return {"playlists": out}


@app.get("/api/search")
def search_music(q: str = "", songs: int = 30, albums: int = 12, artists: int = 8):
    """Searches all of YouTube Music (not just your library): songs, albums (incl. EPs and singles) and artists.
    Songs come back shaped like playlist songs, so they play, like and open menus like any other row."""
    q = q.strip()[:200]
    if len(q) < 2:
        raise HTTPException(400, "Type at least two characters.")
    yt = get_yt()

    def run(kind: str, limit: int) -> list[dict]:
        try:
            with _yt_lock:
                return yt.search(q, filter=kind, limit=max(1, min(limit, 50))) or []
        except HTTPException:
            raise
        except Exception as exc:
            if kind == "songs":
                raise   # no songs at all means the search itself failed: report it
            print(f"search {kind} failed: {exc.__class__.__name__}: {str(exc)[:200]}")
            return []   # a failed albums/artists shelf shouldn't hide the songs

    def thumb(x):
        th = (x or {}).get("thumbnails") or []
        return th[-1]["url"] if th else None

    try:
        raw_songs = run("songs", songs)
        raw_albums = run("albums", albums)
        raw_artists = run("artists", artists)
    except HTTPException:
        raise
    except Exception as exc:
        raise api_error(exc, account_level=True)

    return {
        "q": q,
        "songs": [simplify(t) for t in raw_songs if t.get("videoId")],
        "albums": [{
            "id": a["browseId"], "title": a.get("title") or "", "type": a.get("type") or "Album",
            "year": str(a.get("year") or ""),
            "artists": ", ".join(x["name"] for x in (a.get("artists") or []) if isinstance(x, dict) and x.get("name")),
            "art": thumb(a),
        } for a in raw_albums if a.get("browseId")],
        "artists": [{
            "id": a["browseId"], "title": a.get("artist") or "", "art": thumb(a),
        } for a in raw_artists if a.get("browseId")],
    }


def simplify_watch(t: dict) -> dict:
    """A song from a radio / 'up next' list, shaped like a playlist song (these have a 'length' text and a single 'thumbnail' list)."""
    thumbs = t.get("thumbnail") or t.get("thumbnails") or []
    album = t.get("album") or {}
    secs = t.get("duration_seconds") or 0
    if not secs and t.get("length"):
        try:
            for part in str(t["length"]).split(":"):
                secs = secs * 60 + int(part)
        except ValueError:
            secs = 0
    vid = t.get("videoId")
    return {
        "id": vid, "title": t.get("title") or "", "artists": ", ".join(a["name"] for a in (t.get("artists") or []) if a.get("name")),
        "artistList": artist_list(t.get("artists")), "album": album.get("name") or "", "albumId": album.get("id"),
        "duration": secs, "art": thumbs[-1]["url"] if thumbs else None, "ok": bool(vid), "type": t.get("videoType"), "sid": None,
    }


_suggest_cache: dict[str, tuple[float, list]] = {}
SUGGEST_TTL = 6 * 3600


@app.get("/api/suggest/{pid}")
def suggest(pid: str, refresh: int = 0):
    """Songs you might like to add to a playlist: YouTube Music's own suggestions for playlists you own, the radio of the whole
    playlist, and the radio of a few songs picked from it. Songs already in the playlist are left out."""
    safe_id(pid)
    if is_album(pid) or is_artist(pid):
        return {"songs": []}
    tracks = (read_cache(pid) or {}).get("tracks") or []
    have = {t.get("id") for t in tracks}
    hit = _suggest_cache.get(pid)
    if hit and not refresh and time.time() - hit[0] < SUGGEST_TTL:
        return {"songs": [t for t in hit[1] if t["id"] not in have], "cached": True}   # minus what was added since
    yt = get_yt()
    pool = [t for t in tracks if t.get("ok") and t.get("id")]
    seeds = random.sample(pool, min(2, len(pool)))
    sources: list[list[dict]] = []
    errors: list[str] = []

    def attempt(label: str, fn):
        try:
            with _yt_lock:
                sources.append(fn())
        except HTTPException:
            raise
        except Exception as exc:
            errors.append(f"{label}: {exc.__class__.__name__}: {str(exc)[:160]}")
            print(f"suggest {label} failed: {exc.__class__.__name__}: {str(exc)[:200]}")

    if pid != "LM":   # YouTube Music only offers its own suggestions on playlists you own
        attempt("suggestions", lambda: [simplify(t) for t in yt.get_playlist(pid, limit=0, suggestions_limit=30).get("suggestions") or []])
    attempt("playlist radio", lambda: [simplify_watch(t) for t in yt.get_watch_playlist(playlistId=pid, radio=True, limit=40).get("tracks") or []])
    for s in seeds:
        attempt("song radio", lambda s=s: [simplify_watch(t) for t in yt.get_watch_playlist(videoId=s["id"], radio=True, limit=25).get("tracks") or []])

    songs, seen = [], set(have)
    for rank in range(max((len(x) for x in sources), default=0)):   # take one from each source in turn, so they mix
        for src in sources:
            if rank < len(src):
                t = src[rank]
                if t["id"] and t["ok"] and t["id"] not in seen:
                    seen.add(t["id"]); songs.append(t)
    songs = songs[:40]
    if not songs and errors:
        raise HTTPException(502, errors[0])
    _suggest_cache[pid] = (time.time(), songs)
    return {"songs": songs, "cached": False}


def album_entry(bid: str, data: dict) -> dict:
    al = data.get("album") or {}
    return {"id": bid, "title": data.get("title") or "", "artists": al.get("artists") or "", "year": al.get("year") or "",
            "type": al.get("type") or "Album", "art": al.get("cover")}


@app.get("/api/albums")
def favorite_albums(refresh: int = 0):
    """The albums in your YouTube Music library: the favorites list."""
    if not refresh:
        cached = read_cache("_albums")
        if cached:
            return {**cached, "cached": True}
    try:
        with _yt_lock:
            items = get_yt().get_library_albums(limit=None, order="recently_added")
    except HTTPException:
        raise
    except Exception as exc:
        raise api_error(exc, account_level=True)
    out = []
    for it in items:
        bid = it.get("browseId")
        if not bid:
            continue
        thumbs = it.get("thumbnails") or []
        out.append({
            "id": bid, "title": it.get("title") or "",
            "artists": ", ".join(x["name"] for x in (it.get("artists") or []) if x.get("name")),
            "year": str(it.get("year") or ""), "type": it.get("type") or "Album",
            "art": thumbs[-1]["url"] if thumbs else None,
        })
    data = {"albums": out, "fetched": int(time.time())}
    write_cache("_albums", data)
    return {**data, "cached": False}


class FavBody(BaseModel):
    id: str
    favorite: bool


@app.post("/api/albumfav")
def favorite_album(body: FavBody):
    """Adds the album to your YouTube Music library (or takes it out). This is the favorites list."""
    bid = safe_id(body.id)
    if not is_album(bid):
        raise HTTPException(400, "Not an album.")
    data = read_cache(bid)
    if not data or "playlistId" not in (data.get("album") or {}):
        try:
            data = fetch_album(bid)
        except HTTPException:
            raise
        except Exception as exc:
            raise api_error(exc)
        write_cache(bid, data)
    plid = data["album"].get("playlistId")
    if not plid:
        raise HTTPException(400, "YouTube Music doesn't let this album be added to the library from here.")
    try:
        with _yt_lock:
            get_yt().rate_playlist(plid, "LIKE" if body.favorite else "INDIFFERENT")
    except HTTPException:
        raise
    except Exception as exc:
        print(f"album favorite failed ({bid}): {exc.__class__.__name__}: {str(exc)[:300]}")
        raise api_error(exc, account_level=True)
    saved = read_cache("_albums")
    if saved is not None:
        albums = [x for x in saved.get("albums") or [] if x.get("id") != bid]
        if body.favorite:
            albums.insert(0, album_entry(bid, data))
        saved["albums"] = albums
        write_cache("_albums", saved)
    return {"ok": True, "favorite": body.favorite}


_artist_lists: dict[str, list] = {}


@app.get("/api/artists/{video_id}")
def artists_of(video_id: str):
    """The artists of a song with their page ids, for songs saved before the player remembered them."""
    safe_id(video_id)
    if video_id in _artist_lists:
        return {"artists": _artist_lists[video_id]}
    try:
        with _yt_lock:
            wp = get_yt().get_watch_playlist(videoId=video_id, limit=1)
    except HTTPException:
        raise
    except Exception as exc:
        print(f"artist lookup failed ({video_id}): {exc.__class__.__name__}: {str(exc)[:300]}")
        raise api_error(exc)
    first = (wp.get("tracks") or [{}])[0]
    lst = [x for x in artist_list(first.get("artists")) if x.get("id")]
    if not lst:
        raise HTTPException(404, "YouTube Music doesn't have an artist page for this song.")
    _artist_lists[video_id] = lst
    return {"artists": lst}


_album_ids: dict[str, str] = {}


@app.get("/api/albumid/{video_id}")
def album_id(video_id: str):
    """The album a song belongs to, for songs saved before albums were remembered."""
    safe_id(video_id)
    if video_id in _album_ids:
        return {"id": _album_ids[video_id]}
    try:
        with _yt_lock:
            wp = get_yt().get_watch_playlist(videoId=video_id, limit=1)
    except HTTPException:
        raise
    except Exception as exc:
        print(f"album lookup failed ({video_id}): {exc.__class__.__name__}: {str(exc)[:300]}")
        raise api_error(exc)
    first = (wp.get("tracks") or [{}])[0]
    bid = (first.get("album") or {}).get("id")
    if not bid:
        raise HTTPException(404, "YouTube Music doesn't list an album for this song.")
    _album_ids[video_id] = bid
    return {"id": bid}


class LikeBody(BaseModel):
    id: str
    liked: bool
    track: dict | None = None   # what the page knows about the song, used to add it to the saved copy


def update_liked_cache(video_id: str, liked: bool, track: dict | None) -> None:
    """Keeps the saved copy of Liked songs in step with the like, so nothing has to be downloaded again."""
    data = read_cache("LM")
    if not data:
        return
    tracks = data.get("tracks") or []
    if liked:
        if any(t.get("id") == video_id for t in tracks):
            return
        t = track or {}
        tracks.insert(0, {
            "id": video_id,
            "title": str(t.get("title") or ""),
            "artists": str(t.get("artists") or ""),
            "artistList": t.get("artistList") if isinstance(t.get("artistList"), list) else [],
            "album": str(t.get("album") or ""),
            "albumId": t.get("albumId") if isinstance(t.get("albumId"), str) else None,
            "duration": t.get("duration") if isinstance(t.get("duration"), (int, float)) else 0,
            "art": t.get("art") if isinstance(t.get("art"), str) else None,
            "ok": True,
            "type": t.get("type") if isinstance(t.get("type"), str) else None,
        })
        if isinstance(data.get("count"), int):
            data["count"] += 1
    else:
        kept = [t for t in tracks if t.get("id") != video_id]
        if isinstance(data.get("count"), int):
            data["count"] = max(0, data["count"] - (len(tracks) - len(kept)))
        tracks = kept
    data["tracks"] = tracks
    write_cache("LM", data)


@app.post("/api/like")
def like(body: LikeBody):
    """Like or unlike a song. This is the same thumbs-up as in YouTube Music, so it shows up there too."""
    safe_id(body.id)
    try:
        with _yt_lock:
            get_yt().rate_song(body.id, "LIKE" if body.liked else "INDIFFERENT")
    except HTTPException:
        raise
    except Exception as exc:
        print(f"like failed ({body.id}): {exc.__class__.__name__}: {str(exc)[:300]}")
        raise api_error(exc, account_level=True)
    update_liked_cache(body.id, body.liked, body.track)
    return {"ok": True, "liked": body.liked}


class RemoveBody(BaseModel):
    playlist: str
    id: str | None = None
    sid: str | None = None
    pos: int | None = None   # 1-based position the page saw, to tell apart a song that is in the playlist twice


@app.post("/api/remove")
def remove(body: RemoveBody):
    """Removes one song from one of your playlists, in YouTube Music too."""
    pid = safe_id(body.playlist)
    if pid == "LM":
        raise HTTPException(400, "Liked songs are changed with the star, not removed like this.")
    vid, sid = body.id, body.sid
    if not vid or not sid:
        # The saved copy is older than this feature and has no entry ids: download the playlist again to get them.
        try:
            data = fetch_playlist(pid, None)
        except HTTPException:
            raise
        except Exception as exc:
            raise api_error(exc)
        write_cache(pid, data)
        tracks = data["tracks"]
        pick = None
        if body.pos and 1 <= body.pos <= len(tracks) and (not vid or tracks[body.pos - 1].get("id") == vid):
            pick = tracks[body.pos - 1]
        elif vid:
            pick = next((t for t in tracks if t.get("id") == vid), None)
        if not pick:
            raise HTTPException(404, "That song is no longer in the playlist. Sync it to refresh the list.")
        vid, sid = pick.get("id"), pick.get("sid")
    if not vid or not sid:
        raise HTTPException(400, "YouTube Music doesn't allow removing this one from here (an unavailable song, or "
                                 "a playlist that isn't yours). Remove it in YouTube Music.")
    try:
        with _yt_lock:
            result = get_yt().remove_playlist_items(pid, [{"videoId": vid, "setVideoId": sid}])
    except HTTPException:
        raise
    except Exception as exc:
        print(f"remove failed ({pid}, {vid}): {exc.__class__.__name__}: {str(exc)[:300]}")
        raise api_error(exc)
    if not (isinstance(result, str) and "SUCCEEDED" in result.upper()):
        print(f"remove refused ({pid}, {vid}): {str(result)[:300]}")
        raise HTTPException(502, "YouTube Music did not remove it: " + str(result)[:200])
    print(f"removed {vid} from {pid}")
    # keep the saved copy in step, so nothing has to be downloaded again
    data = read_cache(pid)
    if data:
        tracks = data.get("tracks") or []
        i = next((k for k, t in enumerate(tracks) if t.get("sid") == sid), None)
        if i is None and body.pos and 1 <= body.pos <= len(tracks) and tracks[body.pos - 1].get("id") == vid:
            i = body.pos - 1
        if i is not None:
            del tracks[i]
            if isinstance(data.get("count"), int):
                data["count"] = max(0, data["count"] - 1)
            write_cache(pid, data)
    return {"ok": True}


class AddBody(BaseModel):
    playlist: str
    id: str
    track: dict | None = None   # what the page knows about the song, for the saved copy


@app.post("/api/addtoplaylist")
def add_to_playlist(body: AddBody):
    """Adds a song to the end of one of your playlists, in YouTube Music too."""
    pid, vid = safe_id(body.playlist), safe_id(body.id)
    if pid == "LM" or is_album(pid):
        raise HTTPException(400, "Songs can't be added to that.")
    cached = read_cache(pid)
    if cached and any(t.get("id") == vid for t in cached.get("tracks") or []):
        raise HTTPException(409, "That song is already in the playlist.")
    try:
        with _yt_lock:
            result = get_yt().add_playlist_items(pid, [vid], duplicates=False)
    except HTTPException:
        raise
    except Exception as exc:
        print(f"add to playlist failed ({pid}, {vid}): {exc.__class__.__name__}: {str(exc)[:300]}")
        raise api_error(exc)
    if not (isinstance(result, dict) and "SUCCEEDED" in str(result.get("status", "")).upper()):
        print(f"add to playlist refused ({pid}, {vid}): {str(result)[:300]}")
        raise HTTPException(502, "YouTube Music did not add it. It may already be in the playlist, or the playlist isn't yours.")
    sid = next((r.get("setVideoId") for r in result.get("playlistEditResults") or [] if r), None)
    if cached:
        t = body.track or {}
        cached.setdefault("tracks", []).append({
            "id": vid,
            "title": str(t.get("title") or ""),
            "artists": str(t.get("artists") or ""),
            "artistList": t.get("artistList") if isinstance(t.get("artistList"), list) else [],
            "album": str(t.get("album") or ""),
            "albumId": t.get("albumId") if isinstance(t.get("albumId"), str) else None,
            "duration": t.get("duration") if isinstance(t.get("duration"), (int, float)) else 0,
            "art": t.get("art") if isinstance(t.get("art"), str) else None,
            "ok": True,
            "type": t.get("type") if isinstance(t.get("type"), str) else None,
            "sid": sid,
        })
        if isinstance(cached.get("count"), int):
            cached["count"] += 1
        write_cache(pid, cached)
    print(f"added {vid} to {pid}")
    return {"ok": True, "sid": sid}


_where_cache: dict[str, tuple[float, str, dict]] = {}   # playlist id -> (file time, title, {song id: first position})


@app.get("/api/where/{video_id}")
def where(video_id: str):
    """Which of the saved playlists contain this song, and at what position."""
    safe_id(video_id)
    listing = (read_cache("_playlists") or {}).get("playlists") or []
    found, searched = [], 0
    for p in listing:
        path = cache_path(p["id"])
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        hit = _where_cache.get(p["id"])
        if not hit or hit[0] != mtime:
            data = read_cache(p["id"])
            if not data:
                continue
            first: dict[str, int] = {}
            for i, t in enumerate(data.get("tracks") or [], 1):
                first.setdefault(t.get("id"), i)
            hit = (mtime, data.get("title") or p["title"], first)
            _where_cache[p["id"]] = hit
        searched += 1
        if video_id in hit[2]:
            found.append({"id": p["id"], "title": hit[1], "pos": hit[2][video_id]})
    return {"playlists": found, "searched": searched, "total": len(listing)}


# ---------------------------------------------------------------- audio side

_stream_cache: dict[str, tuple[float, dict]] = {}
_errors: dict[str, tuple[float, str]] = {}


def find_js_runtimes() -> dict:
    """yt-dlp needs Deno or Node. When started from a shortcut the PATH can be older than the install,
    so also look in the places they usually end up."""
    home = Path.home()
    local = Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local")
    extra = {
        "deno": [home / ".deno" / "bin" / "deno.exe", local / "Microsoft" / "WinGet" / "Links" / "deno.exe"],
        "node": [Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "nodejs" / "node.exe"],
    }
    found = {}
    for name in ("deno", "node"):
        path = shutil.which(name) or next((str(p) for p in extra[name] if p.exists()), None)
        if path:
            found[name] = {"path": path}
    return found


JS_RUNTIMES = find_js_runtimes()


def ytdlp_options() -> dict:
    cfg = load_config()
    opts = {
        "format": cfg.get("audio_format", "bestaudio[ext=m4a]/bestaudio/best"),
        "quiet": True,
        "noplaylist": True,
        "skip_download": True,
        # YouTube needs a small JavaScript engine to unlock audio streams. Use Deno, or Node if that's what you have.
        "js_runtimes": JS_RUNTIMES or {"deno": {}, "node": {}},
    }
    if cfg.get("player_client"):
        # optional experiment, e.g. "player_client": ["tv", "web_safari"] in config.json
        pc = cfg["player_client"]
        opts["extractor_args"] = {"youtube": {"player_client": pc if isinstance(pc, list) else [pc]}}
    if MANUAL_COOKIES.exists():
        opts["cookiefile"] = str(MANUAL_COOKIES)
    elif cfg.get("cookies_from_browser"):
        opts["cookiesfrombrowser"] = (cfg["cookies_from_browser"],)
    elif AUTO_COOKIES.exists():
        opts["cookiefile"] = str(AUTO_COOKIES)
    return opts


# yt-dlp sessions are kept and reused. Starting a fresh one for every song re-reads the cookies and
# re-solves YouTube's player script each time, which is most of the wait. A new login or changed
# settings make them start fresh. Two sessions run side by side, so two songs can be looked up at once.
SLOTS = 2
_slots: "queue.Queue[dict]" = queue.Queue()
for _ in range(SLOTS):
    _slots.put({"ydl": None, "key": None})
_id_locks: dict[str, threading.Lock] = {}
_id_guard = threading.Lock()


def slot_ydl(slot: dict):
    key = []
    for f in (MANUAL_COOKIES, AUTO_COOKIES, CONFIG_FILE):
        try:
            key.append(f.stat().st_mtime)
        except OSError:
            key.append(None)
    if slot["ydl"] is None or key != slot["key"]:
        if slot["ydl"] is not None:
            try:
                slot["ydl"].close()
            except Exception:
                pass
        slot["ydl"] = yt_dlp.YoutubeDL(ytdlp_options())
        slot["key"] = key
    return slot["ydl"]


def _fresh(video_id: str):
    hit = _stream_cache.get(video_id)
    return hit[1] if hit and hit[0] > time.time() else None


def resolve(video_id: str) -> dict:
    found = _fresh(video_id)
    if found:
        return found
    with _id_guard:
        id_lock = _id_locks.setdefault(video_id, threading.Lock())
    with id_lock:   # the same song is never looked up twice at once
        found = _fresh(video_id)
        if found:
            return found
        slot = _slots.get()
        started = time.time()
        try:
            info = slot_ydl(slot).extract_info(f"https://music.youtube.com/watch?v={video_id}", download=False)
            url = info.get("url") or (info.get("requested_formats") or [{}])[0].get("url")
            if not url:
                raise RuntimeError("yt-dlp found no audio stream")
        except Exception as exc:
            msg = re.sub(r"\x1b\[[0-9;]*m", "", str(exc)).replace("ERROR: ", "").strip()
            if "unavailable" not in msg.lower() and "not available" not in msg.lower():
                slot["ydl"] = None   # something odd: start a clean session next time
            _errors[video_id] = (time.time(), msg[:200])
            raise RuntimeError(msg[:200]) from exc
        finally:
            _slots.put(slot)
            with _id_guard:
                if len(_id_locks) > 500:
                    _id_locks.clear()
        stream = {"url": url, "headers": info.get("http_headers") or {}}
        print(f"looked up {video_id} in {time.time() - started:.1f}s")
        _errors.pop(video_id, None)
        if len(_stream_cache) > 300:
            _stream_cache.clear()
        _stream_cache[video_id] = (time.time() + STREAM_TTL, stream)
        return stream


@app.get("/api/warm/{video_id}")
async def warm(video_id: str):
    """Resolve a stream ahead of time, so the next track starts instantly."""
    safe_id(video_id)
    try:
        await run_in_threadpool(resolve, video_id)
        return {"ok": True}
    except Exception:
        return {"ok": False}


@app.get("/api/lasterror/{video_id}")
def last_error(video_id: str):
    safe_id(video_id)
    hit = _errors.get(video_id)
    return {"error": hit[1] if hit and time.time() - hit[0] < 120 else None}


@app.get("/api/audio/{video_id}")
async def audio(video_id: str, request: Request):
    """Streams the audio through this server so seeking works and expired URLs are retried."""
    safe_id(video_id)
    for attempt in (1, 2):
        try:
            stream = await run_in_threadpool(resolve, video_id)
        except Exception as exc:
            raise HTTPException(502, str(exc))
        headers = {k: v for k, v in stream["headers"].items() if k.lower() != "accept-encoding"}
        headers["Accept-Encoding"] = "identity"
        if "range" in request.headers:
            headers["Range"] = request.headers["range"]
        client = httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(15, read=60))
        try:
            upstream = await client.send(client.build_request("GET", stream["url"], headers=headers), stream=True)
        except httpx.HTTPError as exc:
            await client.aclose()
            _stream_cache.pop(video_id, None)
            if attempt == 2:
                raise HTTPException(502, f"Could not reach YouTube: {exc.__class__.__name__}")
            continue
        if upstream.status_code in (403, 404, 410) and attempt == 1:
            await upstream.aclose()
            await client.aclose()
            _stream_cache.pop(video_id, None)   # stale URL, look it up again
            continue
        if upstream.status_code >= 400:
            await upstream.aclose()
            await client.aclose()
            raise HTTPException(502, f"YouTube answered {upstream.status_code}")
        keep = {k: v for k, v in upstream.headers.items()
                if k.lower() in ("content-type", "content-length", "content-range", "accept-ranges")}

        async def body(up=upstream, cl=client):
            try:
                async for chunk in up.aiter_raw(65536):
                    yield chunk
            finally:
                await up.aclose()
                await cl.aclose()

        return StreamingResponse(body(), status_code=upstream.status_code, headers=keep)


# ---------------------------------------------------------------- remember the app window's size and position

WINDOW_FILE = BASE / "window.json"   # read by "Onion Player.vbs" when it opens the window


class WindowBody(BaseModel):
    x: int
    y: int
    w: int
    h: int
    maximized: bool = False


@app.post("/api/window")
def save_window(body: WindowBody):
    if not (300 <= body.w <= 10000 and 300 <= body.h <= 10000 and -10000 <= body.x <= 20000 and -10000 <= body.y <= 20000):
        raise HTTPException(400, "Odd window size")
    data = {"x": body.x, "y": body.y, "w": body.w, "h": body.h, "max": False}
    if body.maximized:   # keep the size it had before, so un-maximizing later still goes back to it
        try:
            old = json.loads(WINDOW_FILE.read_text("utf-8"))
            data = {**{k: old[k] for k in ("x", "y", "w", "h") if isinstance(old.get(k), int)}, "max": True}
        except (OSError, ValueError):
            data = {"max": True}
    try:
        WINDOW_FILE.write_text(json.dumps(data), "utf-8")
    except OSError:
        pass
    return {"ok": True}


# ---------------------------------------------------------------- stop when the window is closed

AUTO_QUIT = bool(os.environ.get("ONION_AUTOQUIT"))   # set by "Onion Player.vbs", not by run.bat
QUIT_AFTER = 180    # seconds without a sign of life from the page
_last_ping = time.monotonic()
_seen_ping = False


@app.get("/api/ping")
def ping():
    global _last_ping, _seen_ping
    _last_ping = time.monotonic()
    _seen_ping = True
    return {"ok": True}


def watch_for_close() -> None:
    global _last_ping
    last_tick = time.monotonic()
    while True:
        time.sleep(15)
        now = time.monotonic()
        if now - last_tick > 60:   # the computer was asleep: give the page time to wake up and ping again
            _last_ping = now
        last_tick = now
        limit = QUIT_AFTER if _seen_ping else 600   # never opened at all: give up after 10 minutes
        if now - _last_ping > limit:
            print("The window was closed, stopping.")
            os._exit(0)


# Registered last, so the /api routes above win.
app.mount("/", StaticFiles(directory=BASE / "static", html=True), name="static")


if __name__ == "__main__":
    import webbrowser

    import uvicorn

    import socket
    with socket.socket() as probe:
        probe.settimeout(0.5)
        if probe.connect_ex(("127.0.0.1", PORT)) == 0:
            print(f"Onion Player is already running at http://127.0.0.1:{PORT}")
            print("(probably hidden in the background, started from Onion Player.vbs). Opening it now.")
            print('To stop it, double-click "Stop Onion Player.bat".')
            if not os.environ.get("ONION_NO_BROWSER"):
                webbrowser.open(f"http://127.0.0.1:{PORT}")
            sys.exit(0)

    if not os.environ.get("ONION_NO_BROWSER"):
        threading.Timer(1.5, lambda: webbrowser.open(f"http://127.0.0.1:{PORT}")).start()
    if AUTO_QUIT:
        threading.Thread(target=watch_for_close, daemon=True).start()
    if JS_RUNTIMES:
        print("JavaScript runtime for yt-dlp: " + ", ".join(f"{k} ({v['path']})" for k, v in JS_RUNTIMES.items()))
    else:
        print("WARNING: no JavaScript runtime found, so songs will not play.")
        print("Install Deno with:  winget install DenoLand.Deno   then close this window and run.bat again.")
    print(f"Onion Player is running at http://127.0.0.1:{PORT}  (close this window to stop it)")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")

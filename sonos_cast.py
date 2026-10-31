"""Sonos support: finds speakers on the network and steers them with SoCo.

The speaker fetches the audio itself, so app.py serves it on a second, LAN-facing port that only offers
audio (see start_cast_server there). Everything in this file that touches the network lives in a few small
functions; the rest is plain helpers that the tests cover.
"""
import re
import secrets
import socket
import time

PLAYABLE = {"m4a", "mp4", "aac", "mp3", "flac"}   # what a Sonos can decode; WebM/Opus it cannot
DISCOVER_TTL = 60            # seconds a list of speakers is reused
TOKEN = secrets.token_urlsafe(16)   # part of the audio URL, so only things we told about it can fetch audio

_speakers: dict[str, object] = {}   # ip -> SoCo
_found_at = 0.0


def hms_to_seconds(text) -> float:
    """'0:03:25' -> 205.0. Sonos answers 'NOT_IMPLEMENTED' or '' when it has no position."""
    m = re.fullmatch(r"(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?", str(text or "").strip())
    if not m:
        return 0.0
    h, mi, s = map(int, m.groups())
    return float(h * 3600 + mi * 60 + s)


def seconds_to_hms(seconds) -> str:
    s = max(0, int(seconds or 0))
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}"


def track_id_from_uri(uri) -> str:
    """The video id out of http://ip:port/cast/token/VIDEOID.m4a, or '' for anything else."""
    m = re.search(r"/cast/[^/]+/([A-Za-z0-9_-]{1,80})\.[A-Za-z0-9]{2,4}(?:\?|$)", str(uri or ""))
    return m.group(1) if m else ""


def cast_path(video_id: str, ext: str = "m4a") -> str:
    return f"/cast/{TOKEN}/{video_id}.{ext}"


def lan_ip_for(target_ip: str) -> str:
    """Our address on the network the speaker is on (no packet is sent; the OS just picks the route)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect((target_ip, 1400))
        return s.getsockname()[0]


def format_playable(ext: str | None) -> bool:
    return (ext or "").lower() in PLAYABLE


def discover(force: bool = False) -> list[dict]:
    """Speakers on the network. Slow the first time (a few seconds), then reused for a minute."""
    global _found_at
    if force or time.time() - _found_at > DISCOVER_TTL or not _speakers:
        import soco
        found = soco.discover(timeout=4, allow_network_scan=True) or set()
        _speakers.clear()
        for dev in found:
            if dev.is_visible:
                _speakers[dev.ip_address] = dev
        _found_at = time.time()
    return [{"ip": ip, "name": dev.player_name} for ip, dev in sorted(_speakers.items(), key=lambda kv: kv[1].player_name)]


def speaker(ip: str):
    """Only a speaker we found ourselves can be steered, never an arbitrary address."""
    if ip not in _speakers:
        discover(force=True)
    dev = _speakers.get(ip)
    if dev is None:
        raise LookupError("That speaker was not found on the network.")
    return dev


def play(ip: str, url: str, title: str = "", position: float = 0) -> None:
    dev = speaker(ip).group.coordinator
    dev.play_uri(url, title=title or "Onion Player")
    if position and position > 2:
        # the speaker needs a moment to load the stream before it accepts a seek
        for _ in range(10):
            time.sleep(0.5)
            if dev.get_current_transport_info().get("current_transport_state") in ("PLAYING", "PAUSED_PLAYBACK"):
                try:
                    dev.seek(seconds_to_hms(position))
                except Exception:
                    pass
                break


def command(ip: str, cmd: str, value=None) -> None:
    dev = speaker(ip)
    coord = dev.group.coordinator
    if cmd == "play":
        coord.play()
    elif cmd == "pause":
        coord.pause()
    elif cmd == "stop":
        coord.stop()
    elif cmd == "seek":
        coord.seek(seconds_to_hms(value))
    elif cmd == "volume":
        dev.volume = max(0, min(100, int(value)))
    elif cmd == "mute":
        dev.mute = bool(value)
    else:
        raise ValueError("Unknown command")


def state(ip: str) -> dict:
    dev = speaker(ip)
    coord = dev.group.coordinator
    info = coord.get_current_track_info()
    return {
        "state": coord.get_current_transport_info().get("current_transport_state", ""),
        "pos": hms_to_seconds(info.get("position")),
        "dur": hms_to_seconds(info.get("duration")),
        "id": track_id_from_uri(info.get("uri")),
        "volume": dev.volume,
        "muted": dev.mute,
    }

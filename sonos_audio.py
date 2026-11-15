"""Complete, verified downloads for Sonos; never expose a partial file to a speaker."""
import logging
import threading
import time
from pathlib import Path

import httpx

log = logging.getLogger(__name__)
MAX_FILE = 256 * 1024 * 1024
MAX_CACHE = 512 * 1024 * 1024
MAX_AGE = 24 * 3600
MIME = {"m4a": "audio/mp4", "mp4": "audio/mp4", "aac": "audio/aac",
        "mp3": "audio/mpeg", "flac": "audio/flac"}


class AudioCache:
    def __init__(self, directory):
        self.directory = Path(directory)
        # Bound both simultaneous downloads and disk cleanup. This lock is only
        # for cache preparation; serving completed files never takes it.
        self.lock = threading.Lock()

    def prepare(self, video_id, resolve, invalidate):
        cached = self._cached(video_id)
        if cached:
            return cached
        with self.lock:
            self.directory.mkdir(parents=True, exist_ok=True)
            cached = self._cached(video_id)
            if cached:
                return cached
            error = None
            for attempt in range(3):
                partial = self.directory / (video_id + ".part")
                try:
                    stream = resolve(video_id)
                    ext = stream.get("ext", "").lower()
                    if ext not in MIME:
                        raise ValueError(f"Sonos cannot play this song's audio format ({ext or 'unknown'}).")
                    headers = {k: v for k, v in stream.get("headers", {}).items()
                               if k.lower() not in ("range", "accept-encoding")}
                    headers["Accept-Encoding"] = "identity"
                    with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(15, read=30)) as client:
                        with client.stream("GET", stream["url"], headers=headers) as response:
                            response.raise_for_status()
                            if response.status_code != 200 or response.headers.get("content-encoding", "identity") != "identity":
                                raise RuntimeError("Audio server did not return a complete uncompressed file")
                            length = response.headers.get("content-length")
                            expected = int(length) if length is not None else None
                            if expected is not None and expected > MAX_FILE:
                                raise ValueError("This audio file is too large for the Sonos cache (256 MB).")
                            size = 0
                            started = time.monotonic()
                            with partial.open("wb") as output:
                                for chunk in response.iter_raw(65536):
                                    size += len(chunk)
                                    if size > MAX_FILE or time.monotonic() - started > 180:
                                        raise RuntimeError("Audio download exceeded the size or time limit")
                                    output.write(chunk)
                            if not size or (expected is not None and size != expected):
                                raise RuntimeError("Incomplete audio download")
                    final = self.directory / f"{video_id}.{ext}"
                    partial.replace(final)
                    self._prune(final)
                    return final
                except ValueError:
                    raise
                except Exception as exc:
                    error = exc
                    # Never log signed media URLs or authentication headers.
                    log.warning("Sonos download %s attempt %s failed: %s", video_id, attempt + 1, type(exc).__name__)
                    invalidate(video_id, getattr(getattr(exc, "response", None), "status_code", None))
                    if attempt < 2:
                        time.sleep(0.4 * (attempt + 1))
                finally:
                    partial.unlink(missing_ok=True)
            raise RuntimeError(f"Could not prepare complete audio for Sonos ({type(error).__name__}). Try again.") from None

    def _cached(self, video_id):
        for path in self.directory.glob(video_id + ".*"):
            try:
                if path.suffix[1:] in MIME and path.stat().st_size > 0:
                    path.touch()
                    return path
            except FileNotFoundError:
                pass  # cleanup raced with this lookup; prepare again below
        return None

    def _prune(self, current):
        files = sorted((p for p in self.directory.iterdir() if p.suffix[1:] in MIME), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        for path in files:
            if path == current:
                continue
            stat = path.stat()
            # Give recently handed-out URLs time to finish playing / seeking.
            age = time.time() - stat.st_mtime
            if age > MAX_AGE or (total > MAX_CACHE and age > 3600):
                try:
                    path.unlink()
                    total -= stat.st_size
                except OSError:
                    pass  # Windows may still be serving the file.

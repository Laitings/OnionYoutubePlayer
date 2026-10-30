"""Durable, local playlist snapshots. No login information is saved here."""
import json
import time
import uuid
from pathlib import Path


def batches(items, size=100):
    for start in range(0, len(items), size):
        yield items[start:start + size]


class BackupStore:
    def __init__(self, directory):
        self.directory = Path(directory)

    def save(self, playlist, reason):
        self.directory.mkdir(parents=True, exist_ok=True)
        key = f"{time.time_ns()}-{uuid.uuid4().hex[:8]}"
        data = {"version": 1, "key": key, "created": time.time(),
                "reason": reason, "playlist": playlist}
        path = self.directory / f"{key}.json"
        tmp = path.with_suffix(".tmp")
        with tmp.open("x", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            import os
            os.fsync(f.fileno())
        tmp.replace(path)
        return data

    def read(self, key):
        import re
        if not re.fullmatch(r"\d+-[a-f0-9]{8}", key):
            raise ValueError("Invalid backup")
        return json.loads((self.directory / f"{key}.json").read_text("utf-8"))

    def listing(self):
        result = []
        for path in sorted(self.directory.glob("*.json"), reverse=True):
            try:
                data = self.read(path.stem)
                p = data["playlist"]
                result.append({"key": data["key"], "created": data["created"],
                               "reason": data["reason"], "title": p["title"],
                               "playlist": p["id"], "count": len(p["tracks"]),
                               "reportedCount": p.get("count")})
            except (ValueError, OSError, KeyError, TypeError):
                continue
        return result

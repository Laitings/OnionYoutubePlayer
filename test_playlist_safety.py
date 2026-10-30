"""Regression tests use fake YouTube responses and temporary files, never a real library."""
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
from fastapi import HTTPException
from playlist_backups import BackupStore


def track(i, vid=None):
    return {"id": vid or f"song{i}", "sid": f"entry{i}", "title": f"Song {i}", "artists": "Artist", "ok": True}


class FakeYT:
    def __init__(self):
        self.added, self.removed, self.created, self.moves = [], [], [], []
        self.fail_add = self.fail_remove = None

    def add_playlist_items(self, pid, ids, duplicates=False):
        if self.fail_add is not None and len(self.added) >= self.fail_add:
            raise RuntimeError("connection lost")
        self.added.append(list(ids))
        return {"status": "STATUS_SUCCEEDED", "playlistEditResults": [{"videoId": vid, "setVideoId": f"new{len(self.added)}_{i}"} for i, vid in enumerate(ids)]}

    def remove_playlist_items(self, pid, entries):
        if self.fail_remove is not None and len(self.removed) >= self.fail_remove:
            raise RuntimeError("connection lost")
        self.removed.append(entries)
        return "STATUS_SUCCEEDED"

    def create_playlist(self, title, description, **kwargs):
        self.created.append((title, kwargs))
        return "PLcreated"

    def edit_playlist(self, pid, **kwargs):
        self.moves.append(kwargs)
        return "STATUS_SUCCEEDED"

    def delete_playlist(self, pid):
        self.deleted = pid
        return "STATUS_SUCCEEDED"


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.yt = FakeYT()
        self.data = {"id": "PLtest", "title": "Eight years", "count": 700, "tracks": [track(i) for i in range(700)]}
        self.patches = [patch.object(app, "CACHE_DIR", Path(self.tmp.name)),
                        patch.object(app, "backups", BackupStore(Path(self.tmp.name) / "backups")),
                        patch.object(app, "fetch_playlist", side_effect=lambda *a: copy.deepcopy(self.data)),
                        patch.object(app, "get_yt", return_value=self.yt)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def test_removes_more_than_500_and_reports_entry_ids(self):
        items = [{"id": t["id"], "sid": t["sid"], "pos": i + 1} for i, t in enumerate(self.data["tracks"])]
        r = app.remove_many(app.RemoveManyBody(playlist="PLtest", items=items))
        self.assertEqual(r["removed"], 700)
        self.assertEqual(len(r["removedItems"]), 700)
        self.assertEqual(len(self.yt.removed), 7)
        self.assertEqual(app.read_cache("PLtest")["tracks"], [])
        saved = app.backups.read(r["backup"])
        self.assertEqual(len(saved["playlist"]["tracks"]), 700)

    def test_partial_removal_only_changes_confirmed_entries(self):
        self.yt.fail_remove = 1
        items = [{"id": t["id"], "sid": t["sid"]} for t in self.data["tracks"]]
        r = app.remove_many(app.RemoveManyBody(playlist="PLtest", items=items))
        self.assertEqual((r["removed"], r["failed"]), (100, 600))
        self.assertEqual(len(app.read_cache("PLtest")["tracks"]), 600)
        self.assertIn("connection lost", r["error"])

    def test_stale_entry_never_removes_another_copy(self):
        r = app.remove_many(app.RemoveManyBody(playlist="PLtest", items=[{"id": "song0", "sid": "stale", "pos": 1}]))
        self.assertEqual(r["removed"], 0)
        self.assertEqual(r["skipped"], 1)
        self.assertFalse(self.yt.removed)

    def test_adds_all_1250_without_truncation(self):
        r = app.add_many(app.AddManyBody(playlist="PLtest", tracks=[track(i) for i in range(700, 1950)]))
        self.assertEqual(r["added"], 1250)
        self.assertEqual(len(self.yt.added), 13)
        self.assertEqual(len(app.read_cache("PLtest")["tracks"]), 1950)

    def test_partial_addition_is_reported(self):
        self.yt.fail_add = 1
        r = app.add_many(app.AddManyBody(playlist="PLtest", tracks=[track(i) for i in range(700, 1400)]))
        self.assertEqual((r["added"], r["failed"]), (100, 600))
        self.assertEqual(len(app.read_cache("PLtest")["tracks"]), 800)

    def test_backup_failure_prevents_remote_changes(self):
        with patch.object(app.backups, "save", side_effect=OSError("disk full")):
            with self.assertRaises(HTTPException):
                app.remove_many(app.RemoveManyBody(playlist="PLtest", items=[{"id": "song0", "sid": "entry0"}]))
        self.assertFalse(self.yt.removed)

    def test_delete_requires_yes_on_server(self):
        with self.assertRaises(HTTPException) as raised:
            app.delete_playlist(app.DeleteBody(playlist="PLtest"))
        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(app.backups.listing(), [])

    def test_delete_is_blocked_if_youtube_omits_entries(self):
        self.data["count"] = 701
        with self.assertRaises(HTTPException) as raised:
            app.delete_playlist(app.DeleteBody(playlist="PLtest", confirmation="yes"))
        self.assertEqual(raised.exception.status_code, 409)
        self.assertFalse(hasattr(self.yt, "deleted"))
        self.assertEqual(len(app.backups.listing()), 1)

    def test_confirmed_deletion_has_a_durable_snapshot(self):
        app.delete_playlist(app.DeleteBody(playlist="PLtest", confirmation="yes"))
        self.assertEqual(self.yt.deleted, "PLtest")
        self.assertEqual(app.backups.listing()[0]["count"], 700)

    def test_restore_preserves_duplicates_order_and_large_size(self):
        self.data["tracks"] = [track(i, "repeat" if i % 2 else f"song{i}") for i in range(1250)]
        b = app.backups.save(self.data, "test")
        r = app.restore_backup(app.RestoreBody(key=b["key"]))
        actual = self.yt.created[0][1]["video_ids"] + [vid for group in self.yt.added for vid in group]
        self.assertEqual(actual, [t["id"] for t in self.data["tracks"]])
        self.assertEqual(self.yt.created[0][1]["privacy_status"], "PRIVATE")
        self.assertEqual(r["count"], "1250")

    def test_backup_path_cannot_escape_directory(self):
        with self.assertRaises(ValueError):
            app.backups.read("../browser")

    def test_replace_moves_before_removing_original(self):
        r = app.replace_song(app.ReplaceBody(playlist="PLtest", sid="entry12", replacement="alternative"))
        self.assertTrue(r["ok"])
        self.assertEqual(self.yt.moves[0]["moveItem"], ("new1_0", "entry12"))
        self.assertEqual(self.yt.removed[0][0]["setVideoId"], "entry12")

    def test_failed_move_keeps_original(self):
        with patch.object(self.yt, "edit_playlist", return_value="STATUS_FAILED"):
            with self.assertRaises(HTTPException):
                app.replace_song(app.ReplaceBody(playlist="PLtest", sid="entry12", replacement="alternative"))
        self.assertFalse(self.yt.removed)


if __name__ == "__main__":
    unittest.main()

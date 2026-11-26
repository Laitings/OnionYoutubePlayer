"""Podcast support, with a fake YouTube Music client and temporary files, never a real library."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
from fastapi import HTTPException

EP = "MUSIC_VIDEO_TYPE_PODCAST_EPISODE"


def episode(i, **extra):
    return {"index": i, "title": f"Episode {i}", "description": f"About {i}", "duration": "1 hr 5 min",
            "videoId": f"ep{i}", "browseId": f"MPEDep{i}", "videoType": EP, "date": "Nov 3, 2026",
            "thumbnails": [{"url": f"https://img/{i}"}], **extra}


class FakeYT:
    def __init__(self):
        self.rated = []

    def get_podcast(self, pid, limit=100):
        self.podcast_limit = limit
        return {"title": "Onion Talk", "author": {"name": "Onion Media", "id": "UCx"}, "description": "A show",
                "saved": False, "thumbnails": [{"url": "https://img/cover"}], "episodes": [episode(1), episode(2, duration="")]}

    def _send_request(self, endpoint, body, additional=""):
        """Raw YouTube Music pages, shaped like the real ones (only the parts the parsers read)."""
        def runs(text, bid=None):
            return {"runs": [{"text": text, **({"navigationEndpoint": {"browseEndpoint": {"browseId": bid}}} if bid else {})}]}
        if body["browseId"] == "VLRDPN":   # New episodes: the podcast is the row's second title
            row = {"title": runs("Episode 3", "MPEDep3"), "secondTitle": runs("Onion Talk", "MPSPPLonion"),
                   "subtitle": runs("2d ago"), "onTap": {"watchEndpoint": {"videoId": "ep3"}}}
            shelf = {"musicShelfRenderer": {"contents": [{"musicMultiRowListItemRenderer": row}]}}
            return {"contents": {"twoColumnBrowseResultsRenderer": {"secondaryContents": {"sectionListRenderer": {"contents": [shelf]}}}}}

        def item(title, sub, bid, plid, gone=False):
            return {"musicTwoRowItemRenderer": {
                "title": runs(title, None if gone else bid), "subtitle": runs(sub),
                "navigationEndpoint": {"addToToastAction": {}} if gone else {"browseEndpoint": {"browseId": bid}},
                "thumbnailRenderer": {"musicThumbnailRenderer": {"thumbnail": {"thumbnails": [{"url": "https://img/cover"}]}}},
                "menu": {"menuRenderer": {"items": [{"toggleMenuServiceItemRenderer": {
                    "defaultServiceEndpoint": {"likeEndpoint": {"target": {"playlistId": plid}}}}}]}}}}
        grid = {"gridRenderer": {"items": [
            {"musicTwoRowItemRenderer": {"title": runs("Add podcast"), "navigationEndpoint": {"openPopupAction": {}}}},
            item("New Episodes", "Auto playlist", "VLRDPN", "RDPN"),
            item("Onion Talk", "Onion Media", "MPSPPLonion", "PLonion"),
            item("Gone Show", "Someone", None, "PLgone", gone=True),   # "This podcast is unavailable": its title has no link
        ]}}
        return {"contents": {"singleColumnBrowseResultsRenderer": {"tabs": [{"tabRenderer": {"content": {"sectionListRenderer": {"contents": [grid]}}}}]}}}

    def get_playlist(self, pid, limit=None):
        return {"tracks": [{"videoId": "ep4", "title": "Saved one", "artists": [{"name": "Onion Talk", "id": None}],
                            "thumbnails": [], "duration_seconds": 600}]}

    def rate_playlist(self, pid, rating):
        self.rated.append((pid, rating))

    def search(self, q, filter=None, limit=20):
        if filter == "podcasts":
            return [{"title": "Onion Talk", "browseId": "MPSPPLonion", "thumbnails": [{"url": "https://img/cover"}]},
                    {"title": "Not a podcast id", "browseId": "VLPLx"}]
        return []


class PodcastTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.yt = FakeYT()
        self.patches = [patch.object(app, "CACHE_DIR", Path(self.tmp.name)), patch.object(app, "get_yt", return_value=self.yt)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def test_episode_lengths_from_text(self):
        self.assertEqual(app.text_seconds("1 hr 5 min"), 3900)
        self.assertEqual(app.text_seconds("25 min"), 1500)
        self.assertEqual(app.text_seconds("45 sec"), 45)
        self.assertEqual(app.text_seconds("1:02:03"), 3723)
        self.assertEqual(app.text_seconds("12 min left"), 0)
        self.assertEqual(app.text_seconds(None), 0)

    def test_podcast_opens_like_a_playlist(self):
        d = app.playlist("MPSPPLonion")
        self.assertEqual(d["title"], "Onion Talk")
        self.assertEqual(d["podcast"]["playlistId"], "PLonion")
        self.assertEqual(self.yt.podcast_limit, app.PODCAST_EPISODES)
        e = d["tracks"][0]
        self.assertEqual((e["id"], e["duration"], e["type"], e["date"]), ("ep1", 3900, EP, "Nov 3, 2026"))
        self.assertEqual(e["artistList"], [{"name": "Onion Talk", "id": "MPSPPLonion"}])   # the podcast stands in for the artist
        self.assertEqual(d["tracks"][1]["duration"], 0)
        self.assertEqual(app.read_cache("MPSPPLonion")["count"], 2)

    def test_episode_lists(self):
        new = app.playlist("RDPN")["tracks"]
        self.assertEqual([t["id"] for t in new], ["ep3"])
        self.assertEqual(new[0]["artistList"], [{"name": "Onion Talk", "id": "MPSPPLonion"}])   # each episode names its podcast
        saved = app.playlist("SE")   # falls back to reading it as a playlist
        self.assertEqual(saved["title"], "Episodes for later")
        self.assertEqual((saved["tracks"][0]["id"], saved["tracks"][0]["type"]), ("ep4", EP))

    def test_podcasts_cannot_be_edited_like_playlists(self):
        for pid in ("MPSPPLonion", "RDPN", "SE"):
            with self.assertRaises(HTTPException):
                app.own_playlist(pid)
            self.assertEqual(app.suggest(pid), {"songs": []})

    def test_library_and_subscribe(self):
        lib = app.library_podcasts(refresh=1)["podcasts"]
        self.assertEqual([p["id"] for p in lib], ["RDPN", "SE", "MPSPPLonion", "MPSPPLgone"])
        self.assertEqual((lib[2]["author"], lib[2]["art"], lib[2].get("unavailable")), ("Onion Media", "https://img/cover", None))
        self.assertTrue(lib[3]["unavailable"])   # a podcast YouTube no longer has is listed (so it can be removed), not a crash
        app.subscribe_podcast(app.SubBody(id="MPSPPLgone", subscribe=False))
        self.assertEqual(self.yt.rated[-1], ("PLgone", "INDIFFERENT"))
        app.playlist("MPSPPLonion")
        app.subscribe_podcast(app.SubBody(id="MPSPPLonion", subscribe=False))
        self.assertEqual(self.yt.rated[-1], ("PLonion", "INDIFFERENT"))
        self.assertEqual([p["id"] for p in app.library_podcasts()["podcasts"]], ["RDPN", "SE"])
        app.subscribe_podcast(app.SubBody(id="MPSPPLonion", subscribe=True))
        self.assertEqual(self.yt.rated[-1], ("PLonion", "LIKE"))
        self.assertEqual([p["id"] for p in app.library_podcasts()["podcasts"]], ["RDPN", "SE", "MPSPPLonion"])
        self.assertTrue(app.read_cache("MPSPPLonion")["podcast"]["saved"])
        with self.assertRaises(HTTPException):
            app.subscribe_podcast(app.SubBody(id="PLnot", subscribe=True))

    def test_search_lists_podcasts(self):
        r = app.search_music("onion")
        self.assertEqual(r["podcasts"], [{"id": "MPSPPLonion", "title": "Onion Talk", "art": "https://img/cover"}])


if __name__ == "__main__":
    unittest.main()

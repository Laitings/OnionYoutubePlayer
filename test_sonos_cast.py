import unittest

import sonos_cast as sc


class HelperTests(unittest.TestCase):
    def test_time_conversion(self):
        self.assertEqual(sc.hms_to_seconds("0:03:25"), 205.0)
        self.assertEqual(sc.hms_to_seconds("1:00:01"), 3601.0)
        self.assertEqual(sc.hms_to_seconds("NOT_IMPLEMENTED"), 0.0)
        self.assertEqual(sc.hms_to_seconds(None), 0.0)
        self.assertEqual(sc.seconds_to_hms(205.7), "0:03:25")
        self.assertEqual(sc.seconds_to_hms(-4), "0:00:00")

    def test_track_id_roundtrip(self):
        url = "http://192.168.1.5:8766" + sc.cast_path("dQw4w9WgXcQ", "m4a")
        self.assertEqual(sc.track_id_from_uri(url), "dQw4w9WgXcQ")
        self.assertEqual(sc.track_id_from_uri("http://x/other.mp3"), "")
        self.assertEqual(sc.track_id_from_uri(None), "")

    def test_formats(self):
        self.assertTrue(sc.format_playable("m4a"))
        self.assertTrue(sc.format_playable("MP3"))
        self.assertFalse(sc.format_playable("webm"))
        self.assertFalse(sc.format_playable(""))

    def test_unknown_speaker_is_refused(self):
        sc._speakers.clear()
        sc.discover = lambda force=False: []   # no network in tests
        with self.assertRaises(LookupError):
            sc.speaker("10.0.0.99")


class CastServerTests(unittest.TestCase):
    def test_wrong_token_gets_nothing(self):
        from fastapi.testclient import TestClient
        import app
        client = TestClient(app.cast_app)
        self.assertEqual(client.get("/cast/wrong/abc.m4a").status_code, 404)
        self.assertEqual(client.get("/api/playlists").status_code, 404)   # the library API is not on this server
        self.assertEqual(client.get("/").status_code, 404)


if __name__ == "__main__":
    unittest.main()

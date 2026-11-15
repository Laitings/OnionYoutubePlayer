import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

import app
import sonos_cast as sc
from sonos_audio import AudioCache


class BrokenStream(httpx.SyncByteStream):
    def __iter__(self):
        yield b"abc"
        raise httpx.ReadError("connection interrupted")


class AudioTests(unittest.TestCase):
    def test_forbidden_manual_cookie_falls_back_without_changing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            manual, auto = Path(directory) / "manual", Path(directory) / "auto"
            manual.write_text("manual")
            auto.write_text("automatic")
            with patch.object(app, "MANUAL_COOKIES", manual), patch.object(app, "AUTO_COOKIES", auto), patch.object(app, "_rejected_manual_cookie_mtime", None):
                self.assertEqual(app.selected_cookie_file(), manual)
                app.invalidate_stream("song", 403)
                self.assertEqual(app.selected_cookie_file(), auto)
                self.assertEqual(app.ytdlp_options()["cookiefile"], str(auto))
                self.assertEqual(manual.read_text(), "manual")
                self.assertEqual(auto.read_text(), "automatic")
                app._rejected_manual_cookie_mtime -= 1
                self.assertEqual(app.selected_cookie_file(), manual)

    def test_interrupted_download_retries_before_publishing(self):
        attempts = []
        invalidated = []
        def handle(request):
            attempts.append(request)
            if len(attempts) == 1:
                return httpx.Response(200, headers={"content-length": "6"}, stream=BrokenStream())
            return httpx.Response(200, headers={"content-length": "6"}, stream=httpx.ByteStream(b"abcdef"))
        real_client = httpx.Client
        with tempfile.TemporaryDirectory() as directory:
            cache = AudioCache(directory)
            with patch("sonos_audio.httpx.Client", side_effect=lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw)), patch("sonos_audio.time.sleep"):
                path = cache.prepare("song", lambda _: {"url": "https://audio.test/song", "ext": "m4a"}, lambda key, status: invalidated.append(key))
                self.assertEqual(path.read_bytes(), b"abcdef")
                self.assertEqual(len(attempts), 2)
                self.assertEqual(invalidated, ["song"])
                self.assertFalse(list(Path(directory).glob("*.part")))
                self.assertEqual(cache.prepare("song", lambda _: self.fail("cache miss"), invalidated.append), path)

    def test_incomplete_download_is_never_served(self):
        real_client = httpx.Client
        def handle(request):
            return httpx.Response(200, headers={"content-length": "10"}, stream=httpx.ByteStream(b"short"))
        with tempfile.TemporaryDirectory() as directory:
            with patch("sonos_audio.httpx.Client", side_effect=lambda **kw: real_client(transport=httpx.MockTransport(handle), **kw)), patch("sonos_audio.time.sleep"):
                with self.assertRaises(RuntimeError):
                    AudioCache(directory).prepare("song", lambda _: {"url": "https://audio.test/song", "ext": "m4a"}, lambda key, status: None)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_head_get_and_seek_agree(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "song.m4a"
            path.write_bytes(b"0123456789")
            with patch.object(app, "prepare_sonos_audio", return_value=path):
                client = TestClient(app.cast_app)
                url = sc.cast_path("song")
                head = client.head(url)
                full = client.get(url)
                part = client.get(url, headers={"Range": "bytes=3-5"})
                self.assertEqual(head.headers["content-length"], "10")
                self.assertEqual(head.content, b"")
                self.assertEqual(full.content, b"0123456789")
                self.assertEqual(part.status_code, 206)
                self.assertEqual(part.headers["content-range"], "bytes 3-5/10")
                self.assertEqual(part.content, b"345")
                self.assertEqual(client.get(url, headers={"Range": "bytes=99-"}).status_code, 416)
                self.assertEqual(client.head("/cast/wrong/song.m4a").status_code, 404)


class Device:
    ip_address = "test"
    def __init__(self):
        self.uri = ""
        self.state = "STOPPED"
        self.loads = 0
        self.plays = 0
    @property
    def group(self):
        return type("Group", (), {"coordinator": self})()
    def get_current_track_info(self):
        return {"uri": self.uri}
    def get_current_transport_info(self):
        return {"current_transport_state": self.state}
    def play_uri(self, uri, **kwargs):
        self.loads += 1
        self.uri = uri
    def play(self):
        self.plays += 1
        self.state = "PLAYING"
        raise TimeoutError("response lost after successful Play")


class ControlTests(unittest.TestCase):
    def test_ambiguous_play_timeout_does_not_reload_or_restart(self):
        dev = Device()
        with patch.object(sc, "speaker", return_value=dev), patch.object(sc.time, "sleep"):
            sc.play("test", "http://audio.test/song")
            sc.play("test", "http://audio.test/song")
        self.assertEqual(dev.loads, 1)
        self.assertEqual(dev.plays, 1)

    def test_transition_waits_before_play(self):
        dev = Device()
        states = iter(["TRANSITIONING", "STOPPED", "PLAYING"])
        with patch.object(dev, "get_current_transport_info", side_effect=lambda: {"current_transport_state": next(states)}), patch.object(sc.time, "sleep"):
            sc._transport(dev, dev.play, "PLAYING")
        self.assertEqual(dev.plays, 1)

    def test_group_and_transport_cannot_overlap(self):
        entered, release, command_done = threading.Event(), threading.Event(), threading.Event()
        dev = Device()
        def unjoin():
            entered.set()
            release.wait(2)
        dev.unjoin = unjoin
        dev.stop = lambda: None
        def command():
            sc.command("test", "play")
            command_done.set()
        with patch.object(sc, "speaker", return_value=dev), patch.object(sc.time, "sleep"):
            group = threading.Thread(target=lambda: sc.set_group(["test"], ["removed"]))
            group.start()
            self.assertTrue(entered.wait(1))
            control = threading.Thread(target=command)
            control.start()
            try:
                self.assertFalse(command_done.wait(0.05))
            finally:
                release.set()
                group.join(2)
                control.join(2)
            self.assertTrue(command_done.is_set())


if __name__ == "__main__":
    unittest.main()

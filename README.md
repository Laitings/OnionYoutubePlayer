# Onion Player

A local player for your YouTube Music library. It loads whole playlists at once, so you can search all 800 songs instantly, sort them, and search across every playlist you've synced.

## Start it

**Like an app (no console window, no address bar):** double-click `Onion Player.vbs`. It starts the server hidden and opens the player in its own window. When you close that window the server stops by itself after a few minutes. To get a desktop shortcut with the onion icon, double-click `Make desktop shortcut.vbs` once (you can then right-click it and pin it to the taskbar or Start). The first time you still need to run `run.bat` once, because that sets up the Python environment. Anything the hidden server prints goes to `onion.log`.

**With a console window:** double-click `run.bat`. It opens `http://127.0.0.1:8765` in your browser and keeps running until you close the console window. Useful when something misbehaves, because you can see what it says.

The first run needs Python 3.10 or newer; it installs the packages by itself. The app window uses Edge (or Chrome if Edge is missing). You can also open the page in Edge and choose "Install this site as an app".

The first time, the page asks you to connect YouTube Music. Follow the four steps on screen: copy the request headers of one `browse` request from a private window where you're signed in, and paste them in. That one login is used for both reading your library and playing audio, so your Premium account applies.

## How it works

- `ytmusicapi` reads your playlists and liked songs. Each playlist is downloaded once and saved in `cache/`. After that it opens instantly from the saved copy, and a background check asks YouTube for just the first page and the song count. Only if something changed is the playlist downloaded again. The player keeps all your playlists up to date this way in the background, and **Sync** forces a full re-download if you suspect a change deep inside a playlist.
- `yt-dlp` finds the audio stream when you press play. The server streams it to the page, so seeking works and expired links are retried. While a song plays, the next one loads into a second hidden player and the one after is looked up, so track changes are instant. Resting the pointer on a song for a moment looks it up too, so clicking it starts faster. A song that was never looked up takes a few seconds the first time (the console prints how long each lookup took).
- **Liked songs:** the star on every row, and the star in the player bar, is the same thumbs-up as in YouTube Music. It turns yellow for songs you've liked, and liking or unliking here shows up in the YouTube Music app (and the other way round, the next time you come back to this window). Liking the playing song is also the `L` key.
- **The three dots** in the player bar open a menu for the playing song. *Find in playlists* lists every saved playlist that contains it, with its position. Click one and the player opens that playlist, scrolls to the song and flashes it. Only playlists that are already saved on this computer are searched, so use *Sync all playlists* if a playlist is missing.
- **The three dots on every song** open the same menu, with **Remove from playlist** first. It asks once, then removes the song from the playlist in YouTube Music too (it works on your own playlists; for Liked songs the first option is *Remove from liked songs*). Songs that YouTube Music lists as unavailable can't always be removed from here, in which case the message says so. Playlists saved before this feature get downloaded once more the first time you remove something from them, to learn each song's entry id.
- **Add to playlist:** in any song's three-dot menu (rows and player bar). It lists your playlists, shows the ones that already have the song with a "✓ already added" note (click one to jump to the song), and adds it to the end of the one you pick, in YouTube Music too. It only works for your own playlists; for others YouTube Music refuses and the message says so.
- **Artists:** click an artist name (in a row, the player bar, or an album header) or use *Go to artist* in the three-dot menu. The artist page has a photo, subscribers, description, popular songs, Albums, Singles & EPs and "Fans might also like"; click any card to open it.
- **Albums:** click an album name in the list (or choose *Go to album* in a song's three-dot menu) to open that album, with its artist, year and all its songs, and the song you came from flashed. Albums are saved like playlists. Songs saved before the player remembered album ids make one quick lookup the first time.
- **Favorite albums:** on an album page, *Favorite* adds the album to your YouTube Music library (it shows under Library, Albums in the app), and the **Albums** tab at the top of the sidebar lists them, newest first. Click one to open it. Albums you already have in your library show up there too, and a change made in the YouTube Music app appears here when you come back to this window.
- Search, sort and the queue all run in the page, on the list you're looking at. Click a song and the queue is whatever is on screen at that moment, filtered and sorted.

## Keys

Space play/pause, N next, P previous, S shuffle, R repeat, L like/unlike the playing song, / jump to search, Esc clear search, left/right arrows seek 5 seconds. Your keyboard's media keys work too.

## If something breaks

- **Songs won't play, or "Sign in to confirm" errors:** your login cookies have gone stale. Click "Update login" in the sidebar and paste fresh headers (use a private window and close it afterwards).
- **Nothing plays after YouTube changes something:** update yt-dlp with `.venv\Scripts\python -m pip install -U "yt-dlp[default]"` and restart. If the console mentions a missing JavaScript runtime or "Signature solving failed", install Deno with `winget install DenoLand.Deno`, then close the console window and start `run.bat` again so it sees the new install. Node.js works too if it's already installed and on your PATH.
- **Unavailable songs** are greyed out and skipped. They're usually removed or region-blocked tracks that YouTube Music still lists.
- **Port in use:** set the environment variable `ONION_PORT` to another number before starting.

## Optional settings

Create `config.json` next to `app.py`:

```json
{ "cookies_from_browser": "firefox", "audio_format": "bestaudio" }
```

`cookies_from_browser` makes yt-dlp read cookies straight from a browser instead of the pasted login. Firefox works well. Chrome and Edge are unreliable on Windows because newer versions encrypt their cookies. A `cookies.txt` file (Netscape format) in this folder overrides everything else.

## Good to know

- Everything runs on your computer, and the server only answers to `127.0.0.1`. `browser.json` and `cookies.auto.txt` hold your login, so don't share this folder or commit them anywhere.
- This uses unofficial access to YouTube Music, which Google can change at any time. yt-dlp's own documentation warns that accounts used for heavy automated downloading can get flagged. The player looks up one song at a time, two songs ahead plus songs you rest the pointer on, which is about what normal listening and browsing does, but don't point scripts at it to download your library.

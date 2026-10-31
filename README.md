# Onion Player

A local player for your YouTube Music library. It loads whole playlists at once, so you can search all 800 songs instantly, sort them, and search across every playlist you've synced.

## Start it

**Like an app (no console window, no address bar):** double-click `Onion Player.vbs`. It starts the server hidden and opens the player in its own window. When you close that window the server stops by itself a few seconds later. To get a desktop shortcut with the onion icon, double-click `Make desktop shortcut.vbs` once (you can then right-click it and pin it to the taskbar or Start). The first time you still need to run `run.bat` once, because that sets up the Python environment. Anything the hidden server prints goes to `onion.log`.

The app window opens the way you left it: its size, position and maximized state are saved in `window.json` (next to `app.py`) while you use it. Delete that file to go back to the default size. The window runs in its own browser profile (the `browser-profile` folder), because Edge and Chrome ignore the size and position for a new window when the browser is already running. It is separate from your normal Edge, so it has no extensions and no sign-ins. This only applies to the app window opened by `Onion Player.vbs`.

**With a console window:** double-click `run.bat`. It opens `http://127.0.0.1:8765` in your browser and keeps running until you close the console window. Useful when something misbehaves, because you can see what it says.

The first run needs Python 3.10 or newer; it installs the packages by itself. The app window uses Edge (or Chrome if Edge is missing). You can also open the page in Edge and choose "Install this site as an app".

The first time, the page asks you to connect YouTube Music. Follow the four steps on screen: copy the request headers of one `browse` request from a private window where you're signed in, and paste them in. That one login is used for both reading your library and playing audio, so your Premium account applies.

## How it works

- `ytmusicapi` reads your playlists and liked songs. Each playlist is downloaded once and saved in `cache/`. After that it opens instantly from the saved copy, and a background check asks YouTube for just the first page and the song count. Only if something changed is the playlist downloaded again. The player keeps all your playlists up to date this way in the background, and **Sync** forces a full re-download if you suspect a change deep inside a playlist.
- `yt-dlp` finds the audio stream when you press play. The server streams it to the page, so seeking works and expired links are retried. While a song plays, the next one loads into a second hidden player and the one after is looked up, so track changes are instant. Resting the pointer on a song for a moment looks it up too, so clicking it starts faster. A song that was never looked up takes a few seconds the first time (the console prints how long each lookup took).
- **Liked songs:** the star on every row, and the star in the player bar, is the same thumbs-up as in YouTube Music. It turns yellow for songs you've liked, and liking or unliking here shows up in the YouTube Music app (and the other way round, the next time you come back to this window). Liking the playing song is also the `L` key.
- **Queue:** the queue button in the player bar lists what plays next. Click a song to play it now, move it to the top, or remove it. With shuffle on, Reshuffle in the queue header shuffles the songs that are left. *Play next* and *Add to queue* are in every song's three-dot menu. The player also remembers the song and position you left off at, and shows it again on the next start (press play to continue).
- **Queue:** drag songs in the queue to reorder them (or use the arrow to move one to the top, the cross to remove it). **Save** turns the queue into a new playlist in YouTube Music, and with shuffle on **Reshuffle** shuffles what is left. The queue is remembered, so it is still there after a restart (press `Q` to open it).
- **Playlists:** *New playlist* in the sidebar, and *Rename* / *Delete* in the header of your own playlists (they change YouTube Music too). *New playlist…* is also at the end of every song's *Add to playlist* menu.
- **Duplicates:** your own playlists get a *Duplicates* button when a song is in them twice (or looks like another version of the same song). You can remove single extras, or all extra copies of the very same song at once.
- **Select several songs:** press *Select*, or Ctrl-click / Shift-click rows. Then play them next, add them to the queue or to a playlist, or remove them from the playlist.
- **Recently played** (top of the sidebar) lists the last 100 songs you played. The locate button next to the song title scrolls its playlist to the playing song.
- **Mini player** (button next to the queue button): a second small app window with the Onion icon, the song and artist in its title bar, the cover, previous, play/pause, next, mute and a seek bar. It opens where you left it. It does not stay on top of other windows by itself; Windows PowerToys' Always on Top (Win+Ctrl+T) can do that. It closes itself if Onion Player is closed. `M` mutes and unmutes, and the speaker icon in the player bar does the same.
- **Sonos** (speaker button next to the mini player): lists the Sonos speakers on your network; pick one and the music plays there. Pick several and they are grouped in Sonos, so they play in sync (the first one you picked leads, and volume is set on each speaker). The player bar, queue, seek bar, volume, mute, mini player and sleep timer keep working, and pausing or changing the volume in the Sonos app is followed. Choose *This computer* to bring the sound back. The speaker fetches the audio from this computer, so Onion starts a second server on port 8766 (`ONION_CAST_PORT` changes it) the first time you use Sonos. It serves nothing but audio, under a secret address; the library and your login stay on 127.0.0.1. If Windows asks about the firewall, allow private networks. Songs whose audio only exists as WebM/Opus can't be played by Sonos and are reported as such. A short gap between songs is normal, and the computer has to stay on.
- **Sleep timer** (moon button): pause in 15 to 60 minutes, or after the current song. **Lyrics** (speech bubble button) shows the lyrics for the playing song when YouTube Music has them.
- **The three dots** in the player bar open a menu for the playing song. *Find in playlists* lists every saved playlist that contains it, with its position. Click one and the player opens that playlist, scrolls to the song and flashes it. Only playlists that are already saved on this computer are searched, so use *Sync all playlists* if a playlist is missing.
- **The three dots on every song** open the same menu, with **Remove from playlist** first. It asks once, then removes the song from the playlist in YouTube Music too (it works on your own playlists; for Liked songs the first option is *Remove from liked songs*). Songs that YouTube Music lists as unavailable can't always be removed from here, in which case the message says so. Playlists saved before this feature get downloaded once more the first time you remove something from them, to learn each song's entry id.
- **Add to playlist:** in any song's three-dot menu (rows and player bar). It lists your playlists, shows the ones that already have the song with a "✓ already added" note (click one to jump to the song), and adds it to the end of the one you pick, in YouTube Music too. It only works for your own playlists; for others YouTube Music refuses and the message says so.
- **Artists:** click an artist name (in a row, the player bar, or an album header) or use *Go to artist* in the three-dot menu. The artist page has a photo, subscribers, description, popular songs, Albums, Singles & EPs and "Fans might also like"; click any card to open it.
- **Albums:** click an album name in the list (or choose *Go to album* in a song's three-dot menu) to open that album, with its artist, year and all its songs, and the song you came from flashed. Albums are saved like playlists. Songs saved before the player remembered album ids make one quick lookup the first time.
- **Favorite albums:** on an album page, *Favorite* adds the album to your YouTube Music library (it shows under Library, Albums in the app), and the **Albums** tab at the top of the sidebar lists them, newest first. Click one to open it. Albums you already have in your library show up there too, and a change made in the YouTube Music app appears here when you come back to this window.
- **Search YouTube Music:** the **Search** tab in the sidebar searches all of YouTube Music, not just your library. Type and press Enter: artists and albums (incl. EPs and singles) show as cards, songs as a normal list you can play, like and add to playlists. Click an artist or album card to open it, and use *Back to results* in the Search tab to return. Your last 12 searches are kept in the tab.
- Search, sort and the queue all run in the page, on the list you're looking at. Click a song and the queue is whatever is on screen at that moment, filtered and sorted.

## Library tools and recovery

- **Automatic snapshots:** before adding/removing songs, renaming, replacing a song or deleting a playlist, Onion first fetches the playlist and saves the returned entries in `backups/`. If fetching or saving fails, that edit is blocked. Snapshots contain song metadata and entry order, never your login. They are excluded from Git and are not automatically deleted.
- **Backups & recovery** in the sidebar lets you save a snapshot manually, download its JSON, or recover a snapshot as a **new private playlist**. This is a recovery copy, not an in-place undo: the original playlist and its URL are not overwritten. Duplicate entries and order are preserved where YouTube permits them. Entries without video ids cannot be recreated, and unavailable videos may be rejected by YouTube. Keep downloaded copies somewhere separate from this folder.
- **Delete still requires typing `yes`**, and the server checks the confirmation too. If YouTube reports more entries than it returns for the snapshot, deletion is blocked. The backup screen shows both counts. For example, a playlist might report 861 entries but return only 860: the snapshot then contains those 860, not the missing entry.
- **Large selections:** additions and removals run in batches of 100 without silently truncating the selection. Only batches YouTube confirms are reflected in the cache and UI. A failure reports the confirmed count and the unconfirmed remainder; sync before retrying an uncertain operation. Each operation saves one snapshot before its first batch.
- **Whole queue:** all upcoming songs are saved locally. The queue initially draws 200 songs; **Show next** reveals additional portions without changing playback order. Saving a queue as a playlist also handles lists larger than 1,000 songs and reports partial failures.
- **Compare duplicates:** choose which copy to keep, and use **Listen** to compare versions without replacing the queue. Bulk cleanup only includes identical video ids. Alternate versions require individual review and confirmation. The normal player pauses during a preview and resumes when you close the comparison if it was playing before.
- **Find replacements** lists unavailable entries. Search, listen and choose an alternative, then confirm. Where YouTube exposes the original entry id and video id, the alternative is added and moved to that position before the old entry is removed. If a step fails, the original is kept where possible and the backup remains available. If the old entry cannot be removed safely, Onion offers to add the alternative at the end instead, leaving the old entry for manual cleanup in YouTube Music.
- **Shuffle options:** Balanced spreads artists apart where possible; Discovery also favors songs outside Recently played, then older plays; Fully random keeps ordinary shuffle. Listening history covers the last 100 distinct songs in this browser profile, not your entire YouTube history.
- **Save search / Smart playlists:** save local rules for search words, artist, source playlist, liked songs, maximum length and exclusion of recently played songs. Views are evaluated against synced playlists when opened. Genre terms can match playlist names but are not inferred from the music. Creating, editing or removing a smart view does not change YouTube playlists.
- **Organize** on a playlist lets you pin it or assign a local folder. Folders, pins, smart views, queue and recent plays belong to the browser profile on this computer. They do not sync to YouTube or between browsers.
- Small windows have a **More** button in the player to reveal queue, lyrics, timer, shuffle, repeat and volume. Opening another playlist or album clears the old song-search filter.

## Development checks

The regression tests use temporary directories and a fake YouTube client. They do not edit a real account:

```powershell
.venv\Scripts\python -m unittest test_playlist_safety -v
node test_player_tools.cjs
```

## Keys

Space play/pause, N next, P previous, S shuffle, R repeat, L like/unlike the playing song, / jump to search, Esc clear search, left/right arrows seek 5 seconds. Your keyboard's media keys work too.

## If something breaks

- **Songs won't play, or "Sign in to confirm you're not a bot" / "not available in your country" errors:** the cookies used for playback have gone stale or been rejected. First click "Update login" in the sidebar and paste fresh headers (use a private window and close it afterwards). If that doesn't help, or it keeps coming back, give playback its own cookie file, which YouTube rotates much less:
  1. Open a new private window and sign in at `youtube.com`.
  2. In that same window, open `https://www.youtube.com/robots.txt`. Keep it the only tab.
  3. With a cookies.txt extension (for example "Get cookies.txt LOCALLY"), export the cookies for youtube.com.
  4. Close the private window straight away, so it can't rotate them.
  5. Save the file as `cookies.txt` next to `app.py` and restart the player.

  A `cookies.txt` there is used for playback instead of the pasted headers (your playlists and albums still use the headers), so "Update login" won't fix playback while it is stale: repeat the export instead. Use a separate export on each computer and never copy the file between them. It is in `.gitignore`. A region error on one specific song can also be a real region block.
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

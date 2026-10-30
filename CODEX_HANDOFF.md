# Codex handoff — 2026-10-30

This note describes the changes made in the current working tree, following Claude's playlist-deletion confirmation change. User-facing instructions are in README.md, under **Library tools and recovery**.

## User requirements to preserve

- Lil Goodies is the user's prized playlist, built over approximately eight years. Do not use it for live mutation or deletion tests.
- Keep the requirement to type `yes` before deleting a playlist. Codex preserved Claude's UI confirmation and added the equivalent check on the server.
- Implementation was authorized; testing remote destructive actions against the user's real library was not performed.

## Working tree and files

Changes are local, uncommitted and unpushed. Include untracked files when reviewing; `git diff` alone will omit new modules and tests.

| File | Changes |
| --- | --- |
| app.py | Serialized playlist edits/syncs; fresh snapshots before playlist mutations; batched bulk operations with partial-result reporting; large playlist creation; server deletion confirmation and count-mismatch guard; backup/export/recovery/replacement endpoints. |
| playlist_backups.py (new) | Local JSON snapshot store with unique keys, atomic replacement, flushed file writes, listing and validated key lookup; shared batch helper. |
| static/app.js | Queue persistence without the 300-song cap, incremental queue display, search reset on navigation, confirmed-only removal updates, partial-result messages, integration with library tools and deferred startup. |
| static/player-tools.js (new) | Pure shuffle-ordering and smart-playlist rule helpers, also usable by Node tests. |
| static/library-tools.js (new) | Pins/folders, saved searches and smart playlists, shuffle modes, separate audio previews, duplicate comparison, replacement search, backup/recovery dialogs and compact-window controls. |
| static/index.html | New controls, preview audio element and script loading order. |
| static/style.css | Responsive controls, folder/rule/comparison styles and popup positioning relative to player height. |
| .gitignore | Excludes backups/. |
| README.md | Feature behavior, recovery limitations and test commands. |
| test_playlist_safety.py (new) | 13 backend regression tests with temporary directories and a fake YouTube client. |
| test_player_tools.cjs (new) | Shuffle and smart-playlist rule tests. |

## Behavior and architecture details

### Safety, batches and recovery

- `serialized_edit` uses a process-local RLock around playlist edits and playlist sync routes. Cache writes use unique temporary filenames. This is not a lock shared between separate running server processes.
- `snapshot` fetches fresh playlist data before an edit, writes the snapshot under backups/, then refreshes the playlist cache. Fetch/save failures prevent the edit from starting.
- The fetched playlist metadata now includes description and privacy as well as ordered normalized tracks. No authentication files are included in snapshots.
- Bulk add/remove requests process the entire selection in batches of 100. Responses distinguish confirmed results, skipped entries, failed/unconfirmed remainder and errors. Removals return entry ids so the browser updates only confirmed rows.
- Bulk removal requires matching current entry ids, or an exact matching position/video pair if no entry id was supplied. A stale explicit entry id never falls back to another copy.
- Queue-to-playlist creation no longer truncates at 1,000 songs or deliberately deduplicates its input. Creation and subsequent batches report partial completion if a later batch fails.
- `POST /api/playlist/delete` requires `confirmation: "yes"` (trimmed, case insensitive). It snapshots first and refuses deletion with HTTP 409 when the reported count exceeds the number of returned tracks.
- New routes: GET /api/backups, GET /api/backups/{key} (JSON download), POST /api/backup, POST /api/restore and POST /api/replace.
- Recovery creates a **new private playlist**. It is not an in-place undo, does not restore the old URL, and does not overwrite the existing playlist. Missing video ids cannot be recreated; YouTube may reject unavailable videos. Snapshot descriptions/privacy are retained in JSON, but recovery currently creates the copy with a blank description and PRIVATE visibility.
- Replacement adds an alternative, moves it before the original entry, then removes the original. Failed steps leave the original where possible and report that a backup is available. If the original lacks removal identifiers, the UI offers addition at the end instead of automatic replacement.
- After a lost connection, a remote batch may have happened without its response reaching Onion. The UI reports it as unconfirmed and tells the user to sync before retrying; there is no automatic retry of destructive edits.

### Browser features

- All upcoming queue entries are persisted to localStorage; the panel renders 200 initially and offers Show next. Storage errors are reported instead of silently swallowed.
- `player-tools.js` loads before app.js; library-tools.js loads afterward and invokes `bootPlayer()`. Keep this ordering: core event registration must finish before startup renders use extension helpers.
- Smart views, pins and folders are stored per browser origin/profile, not in YouTube. Smart rules cover query words, artist, source playlist, liked state, maximum duration and absence from Recently played. Rules use synced playlist data; genre matching is text matching, not musical classification.
- Balanced shuffle spreads artist groups apart where possible. Discovery also prioritizes absent/older local history entries. Fully random remains available. History covers the last 100 distinct songs, not the account's full listening history.
- Duplicate comparison provides Keep radios and separate Listen previews. Bulk cleanup considers identical video ids only; possible alternate versions require individual review. Preview playback does not replace the queue.
- Narrow windows have More player controls; popup placement follows player height. Changing playlist/album clears the old song filter.

## Lil Goodies: observed discrepancy and saved snapshot

YouTube reported **861 entries** but returned **860 tracks**. The missing entry was not identified; do not assume the snapshot contains it. This is the reason for displaying both counts and blocking deletion on a mismatch.

A real, local manual snapshot was saved at:

`backups/1793359498298792100-d2121bd9.json`

It contains the 860 returned tracks. A final read-only comparison showed the cached video-id/entry-id order matched that snapshot. No songs were added, removed or replaced, and no real playlist was renamed, deleted or recovered during testing.

## Validation actually performed

```powershell
.venv\Scripts\python.exe -m unittest test_playlist_safety -v
node test_player_tools.cjs
node --check static/app.js
node --check static/library-tools.js
node --check static/player-tools.js
.venv\Scripts\python.exe -m py_compile app.py playlist_backups.py
git diff --check
```

- All 13 Python tests passed: large selections, partial failures, stale entries, backup failure, confirmation, deletion-count guard, recovery order/duplicates and replacement failure safety. All remote mutations in these tests used FakeYT and temporary storage.
- Node helper tests passed, including 1,200-entry shuffle permutations and smart-rule filtering.
- Browser checks used a separate server at 127.0.0.1:8766: 855 upcoming songs survived reload; queue rendering expanded from 200 to 400; a smart view returned the expected three Murr Murr entries; pin/folder controls were exercised in the test origin; narrow layouts were checked at 590px and 360px with no horizontal overflow at 360px.
- Album navigation cleared the previous query and showed all nine Highway 61 Revisited tracks. Replacement search returned ordinary/acoustic Stunner candidates without applying a replacement.
- The real playlist deletion dialog was tested for disabled/enabled state with no/yes, then **cancelled**. No deletion request was submitted. Do not repeat destructive UI tests on the real library.
- A fresh browser startup had no console errors. An initial cross-script showDups registration error was fixed by deferring the callback.
- Live remote mutation/recovery behavior was not exercised against the account; it was verified with the fake client and the installed ytmusicapi implementation/signatures.

## Runtime handover

The separate test server and its browser tabs were closed. The user's original server was not restarted by Codex. If it is still running old Python code, close the app, run Stop Onion Player.bat, then open Onion Player.vbs. Refreshing only the page does not reload backend code.

No commits or pushes were made. Local test-origin pins/smart views belong to port 8766 and do not configure the user's normal port-8765 browser profile.

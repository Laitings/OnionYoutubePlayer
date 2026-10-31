"use strict";
const $ = (s, r = document) => r.querySelector(s);
const A1 = $("#audio"), A2 = $("#audio2");
let audio = A1, spare = A2;   // two players: one plays while the other preloads the next song
const both = f => [A1, A2].forEach(f);
const on = (evt, fn) => both(el => el.addEventListener(evt, e => { if (el === audio) fn(e); }));   // only the active player counts
both(el => el.addEventListener("error", () => { el._failed = true; }));
const cast = { ip: "", ips: [], name: "", id: "", playing: false, heard: false, since: 0, nudge: false, timer: null, volTimer: null, busy: false };   // Sonos state, see the Sonos section
const streamUrl = t => `/api/audio/${encodeURIComponent(t.id)}`;
const LIMIT = 2500;   // most rows drawn at once; search narrows it down

const store = {
  get(k, d) { try { const v = localStorage.getItem("onion." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("onion." + k, JSON.stringify(v)); return true; } catch { toast("Could not save locally: browser storage is full or blocked. Export important playlists using Backups & recovery."); return false; } },
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = s => {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
const when = ms => new Date(ms * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/* ---------- text folding: "bjork" finds "Björk", "o" finds "ø" ---------- */
const SPECIAL = { "ø": "o", "đ": "d", "ł": "l", "ß": "s" };
const foldCache = new Map();
function foldChar(c) {
  let f = foldCache.get(c);
  if (f !== undefined) return f;
  f = c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  f = SPECIAL[f] ?? f;
  if (f.length !== c.length) f = c.toLowerCase().length === c.length ? c.toLowerCase() : c;   // keep indexes aligned
  foldCache.set(c, f);
  return f;
}
function fold(s) {
  s = String(s ?? "");
  if (/^[\x00-\x7f]*$/.test(s)) return s.toLowerCase();
  let out = "";
  for (const c of s) out += foldChar(c);
  return out;
}
function hl(text, terms) {
  if (!terms.length) return esc(text);
  const f = fold(text), marks = [];
  for (const term of terms) {
    for (let i = f.indexOf(term); i !== -1; i = f.indexOf(term, i + term.length)) marks.push([i, i + term.length]);
  }
  if (!marks.length) return esc(text);
  marks.sort((a, b) => a[0] - b[0]);
  let out = "", pos = 0;
  for (const [s, e] of marks) {
    if (e <= pos) continue;
    const st = Math.max(s, pos);
    out += esc(text.slice(pos, st)) + "<mark>" + esc(text.slice(st, e)) + "</mark>";
    pos = e;
  }
  return out + esc(text.slice(pos));
}
const artUrl = (a, px) => !a ? "" : /=w\d+-h\d+/.test(a) ? a.replace(/=w\d+-h\d+.*$/, `=w${px}-h${px}-l90-rj`) : a;

/* ---------- state ---------- */
const S = {
  playlists: [], plId: null, seq: 0, sig: "",
  tracks: [], allTracks: null, scope: "one", sort: "order", q: "",
  view: [], queue: [], order: [], pos: -1, cur: null, fails: 0,
  liked: null,    // Set of liked song ids, once Liked songs has been read
  albums: null, favAlbums: null,   // the favorite albums list (your YouTube Music library albums), and its ids
  tab: store.get("tab", "playlists"), results: null, sugg: [], suggFor: null,   // results: the last YouTube Music search
  focus: null,    // {id, at}: a song to scroll to and flash the next time the list is drawn
  shuffle: store.get("shuffle", false), repeat: store.get("repeat", "off"),
  restored: false, resume: null,   // the song from last time is shown but not loaded yet / where to continue it
  sel: new Set(), selecting: false, lastPick: null,   // rows ticked for a bulk action
  sleepEnd: false,   // stop when the current song ends
};

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 5000);
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let d = "";
    try { d = (await r.json()).detail; } catch { /* not JSON */ }
    const e = new Error(d || r.statusText);
    e.status = r.status;
    throw e;
  }
  return r.json();
}
function onApiError(e) {
  if (e.status === 401) showSetup(e.message);
  else toast(e.message || "Something went wrong");
}

/* ---------- setup ---------- */
function showSetup(msg, canCancel) {
  $("#setup").hidden = false;
  $("#setup-err").textContent = msg || "";
  $("#setup-cancel").hidden = !canCancel;
  $("#setup-text").focus();
}
$("#setup-cancel").onclick = () => { $("#setup").hidden = true; };
$("#relogin").onclick = () => showSetup("", true);
$("#setup-form").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("#setup-go");
  btn.disabled = true; btn.textContent = "Checking…";
  try {
    await api("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ headers: $("#setup-text").value }) });
    $("#setup").hidden = true;
    $("#setup-text").value = "";
    S.plId = null;
    loadPlaylists();
  } catch (err) {
    $("#setup-err").textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = "Connect";
  }
});

/* ---------- playlists ---------- */
const recentEntry = f => (!f || fold("Recently played").includes(f))
  ? `<button class="pl${S.plId === "recent" ? " active" : ""}" data-id="recent"><span class="t">Recently played</span><span class="n"></span></button>` : "";
function renderPlaylists() {
  updateHeadActions();
  const f = fold($("#plfilter").value.trim());
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)));
  $("#plfilter").placeholder = S.tab === "search" ? "Search all of YouTube Music" : S.tab === "albums" ? "Filter albums" : "Filter playlists";
  if (S.tab === "search") {
    const recent = store.get("recent", []);
    const back = S.results && S.plId !== "search" ? `<button class="sr back" data-q="${esc(S.results.q)}" data-back="1">← Back to results for “${esc(S.results.q)}”</button>` : "";
    $("#playlists").innerHTML = '<div class="sidecap">Songs, albums and artists from all of YouTube Music. Type and press Enter.</div>' + back
      + (recent.length ? '<div class="sidecap">Recent searches</div>' + recent.map(r => `<button class="sr" data-q="${esc(r)}">${esc(r)}</button>`).join("") : "");
    return;
  }
  if (S.tab === "albums") {
    if (!S.albums) { $("#playlists").innerHTML = '<div class="sidecap">Loading your albums…</div>'; return; }
    const list = S.albums.filter(a => !f || fold(`${a.title} ${a.artists}`).includes(f));
    $("#playlists").innerHTML = list.length ? list.map(a => `
      <button class="al${a.id === S.plId ? " active" : ""}" data-id="${esc(a.id)}">
        <img class="alart" loading="lazy" decoding="async" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'" src="${esc(artUrl(a.art, 96))}">
        <span class="altext"><span class="t">${esc(a.title)}</span><span class="s">${esc([a.artists, a.year].filter(Boolean).join(" · "))}</span></span>
      </button>`).join("")
      : `<div class="sidecap">${S.albums.length ? "No matches." : "No favorite albums yet. Open an album and press Favorite."}</div>`;
    return;
  }
  $("#playlists").innerHTML = recentEntry(f) + S.playlists.filter(p => !f || fold(p.title).includes(f)).map(p => {
    const n = String(p.count ?? "").match(/\d[\d.,]*/);
    return `<button class="pl${p.id === S.plId ? " active" : ""}" data-id="${esc(p.id)}"><span class="t">${esc(p.title)}</span><span class="n">${n ? esc(n[0]) : ""}</span></button>`;
  }).join("");
  paintLibrary(f);
}
$("#plfilter").addEventListener("input", renderPlaylists);
$("#plfilter").addEventListener("keydown", e => {
  if (e.key === "Enter" && S.tab === "search") runSearch(e.target.value);
});
$("#playlists").addEventListener("click", e => {
  const sr = e.target.closest(".sr");
  if (sr) { if (sr.dataset.back) showSearch(); else { $("#plfilter").value = sr.dataset.q; runSearch(sr.dataset.q); } return; }
  const b = e.target.closest(".pl");
  if (b) { S.scope = "one"; syncScopeButtons(); openPlaylist(b.dataset.id); return; }
  const a = e.target.closest(".al");
  if (a) { S.scope = "one"; syncScopeButtons(); S.sig = ""; openPlaylist(a.dataset.id); }
});
document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => {
  S.tab = b.dataset.tab; store.set("tab", S.tab);
  $("#plfilter").value = "";
  renderPlaylists();
  if (S.tab === "search") $("#plfilter").focus();
});

async function loadPlaylists() {
  try {
    const first = await api("/api/playlists");
    S.playlists = first.playlists;
    let synced = first.synced || {};
    renderPlaylists();
    if (!S.plId) openPlaylist(S.playlists.some(p => p.id === store.get("last")) ? store.get("last") : "LM");
    if (S.plId !== "LM") loadLiked();   // opening Liked songs reads them anyway
    loadAlbums();
    if (first.cached) {
      const fresh = await api("/api/playlists?refresh=1");
      S.playlists = fresh.playlists;
      synced = fresh.synced || synced;
      renderPlaylists();
    }
    backgroundSync(synced);
  } catch (e) { onApiError(e); }
}

/* Keeps every playlist saved on disk: downloads the ones never saved, re-checks the ones not checked for 6 hours. */
let bgRunning = false;
async function backgroundSync(synced) {
  if (bgRunning) return;
  bgRunning = true;
  const staleBefore = Date.now() / 1000 - 6 * 3600;
  const todo = S.playlists.filter(p => !(synced[p.id] > staleBefore));
  try {
    for (let i = 0; i < todo.length; i++) {
      $("#bgstatus").textContent = `Updating playlists, ${i + 1} of ${todo.length}`;
      if (todo[i].id === S.plId) continue;   // the open playlist is already being checked
      try {
        const d = await api(`/api/playlist/${encodeURIComponent(todo[i].id)}?refresh=1`);
        if (d.id === "LM") noteLiked(d);
        S.allTracks = null;
      }
      catch { /* one playlist failing is not worth interrupting for; it shows up if you open it */ }
      await new Promise(r => setTimeout(r, 600));   // a short pause between playlists keeps the load gentle
    }
  } finally { bgRunning = false; $("#bgstatus").textContent = ""; }
}

/* ---------- back button: every page you open is a history entry, so Back (mouse button, Alt+Left, swipe) returns to the previous page ---------- */
let navRestoring = false;
function pushNav(id) {
  if (navRestoring || !id) return;
  const cur = history.state && history.state.id;
  if (cur === id) return;   // refreshing the page that is already showing
  if (cur) history.pushState({ id }, ""); else history.replaceState({ id }, "");   // the first page replaces the empty entry
}
addEventListener("popstate", e => {
  const id = e.state && e.state.id;
  if (!id) return;
  closeMenu();
  navRestoring = true;
  try {
    S.scope = "one"; syncScopeButtons();
    S.q = ""; $("#q").value = "";
    if (id === "search") { if (S.results) showSearch(); }
    else { S.sig = ""; openPlaylist(id); }
  } finally { navRestoring = false; }
});

const isPage = id => /^(MPRE|UC|MPLA)/.test(id);   // album and artist pages, which have a header and are not in the playlist list
async function openPlaylist(id, full = false) {
  if (id.startsWith("smart:")) return openSmart(id.slice(6));
  if (id === "recent") return showRecent();
  S.smart = null;
  if (id !== S.plId) { S.q = ""; $("#q").value = ""; }
  endSelect();
  S.plId = id; store.set("last", id);
  pushNav(id);
  if (!isPage(id)) showHero(null);
  $("#suggbox").hidden = true;
  renderPlaylists();
  $("#side").classList.remove("open");
  const meta = S.playlists.find(p => p.id === id);
  $("#plname").textContent = meta ? meta.title : /^MPRE/.test(id) ? "Album" : /^(UC|MPLA)/.test(id) ? "Artist" : "Playlist";
  if (S.scope === "one") $("#plmeta").textContent = "Loading…";
  const seq = ++S.seq, url = `/api/playlist/${encodeURIComponent(id)}`;
  try {
    const data = await api(url + (full ? "?refresh=1&full=1" : ""));
    if (seq !== S.seq) return;
    applyPlaylist(data);
    loadSuggest(id);
    if (data.cached) {   // show the saved copy right away, then quietly check for changes
      const base = $("#plmeta").textContent;
      $("#plmeta").textContent = base + ", checking for changes…";
      try {
        const fresh = await api(url + "?refresh=1");
        if (seq === S.seq) applyPlaylist(fresh);
      } catch (e) {
        if (seq === S.seq) $("#plmeta").textContent = base;
        throw e;
      }
    }
  } catch (e) {
    if (seq !== S.seq) return;
    if (!S.sig.startsWith(id + ":")) {   // nothing of this playlist is on screen: don't leave the previous one under the new title
      S.tracks = []; S.sig = "";
      $("#plmeta").textContent = "Couldn't load this playlist";
      if (S.scope === "one") render();
    }
    onApiError(e);
  }
}

const prep = (t, n, pl = "", g = 0, pid = t.pid) => ({ ...t, n, pl, g, pid, _h: fold(`${t.title} ${t.artists} ${t.album} ${pl}`) });

/* ---------- album page: big cover, title, artist, year, play buttons ---------- */
const hero = $("#hero");
const playTime = sec => { const m = Math.round(sec / 60), h = Math.floor(m / 60); return h ? `${h} hr ${m % 60} min` : `${Math.max(1, m)} min`; };
const artistsHtml = (t, terms = []) => {
  const list = t.artistList;
  if (list && list.length) return list.map(a => a.id ? `<span class="artlink" data-n="${esc(a.name)}">${hl(a.name, terms)}</span>` : hl(a.name, terms)).join(", ");
  return t.artists ? `<span class="artlink" data-n="">${hl(t.artists, terms)}</span>` : "";
};
const shelfCard = (x, round, sub) => `<button class="card2${round ? " round" : ""}" data-id="${esc(x.id)}"><img loading="lazy" decoding="async" alt="" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='/logo.svg'" src="${x.art ? esc(artUrl(x.art, 320)) : '/logo.svg'}"><span class="ct">${esc(x.title)}</span><span class="cs">${esc(sub)}</span></button>`;
const shelfSec = (title, items, round, sub) => items.length ? `<section class="shelf"><h2>${title}</h2><div class="cards">${items.map(x => shelfCard(x, round, sub(x))).join("")}</div></section>` : "";
function showShelves(ar) {
  $("#shelves").innerHTML = ar ? shelfSec("Albums", ar.albums, false, x => [x.year, x.type && x.type !== "Album" ? x.type : ""].filter(Boolean).join(" · "))
    + shelfSec("Singles & EPs", ar.singles, false, x => [x.year, x.type].filter(Boolean).join(" · "))
    + shelfSec("Fans might also like", ar.related, true, x => x.subscribers ? x.subscribers + " subscribers" : "Artist") : "";
}
$("#shelves").addEventListener("click", e => {
  const c = e.target.closest(".card2");
  if (c) openPage(c.dataset.id);
});
function showHero(data) {
  const al = data && data.album, ar = data && data.artist;
  hero.hidden = !(al || ar);
  hero.classList.toggle("artist", !!ar);
  $(".head").classList.toggle("album", !!(al || ar));
  $("#herofav").hidden = !al;
  $("#rowshead").hidden = !ar;
  $("#rowshead").textContent = "Popular songs";
  showShelves(ar);
  if (!al && !ar) return;
  const n = data.tracks.length, img = $("#herocover"), src = al || ar;
  $("#herokind").textContent = ar ? "Artist" : (al.type || "Album");
  $("#heroexp").hidden = !(al && al.explicit);
  $("#herotitle").textContent = data.title;
  if (ar) {
    $("#heroby").textContent = ar.stats || "";
    $("#herostats").textContent = ar.views || "";
  } else {
    const list = (al.artistList || []).filter(a => a.id);
    $("#heroby").innerHTML = list.length ? list.map(a => `<span class="artlink" data-id="${esc(a.id)}">${esc(a.name)}</span>`).join(", ") : esc(al.artists || "");
    $("#herostats").textContent = [al.year, `${n} ${n === 1 ? "song" : "songs"}`, al.seconds ? playTime(al.seconds) : ""].filter(Boolean).join(" · ");
  }
  img.onerror = () => { img.onerror = null; img.src = "/logo.svg"; };
  const pic = ar ? ar.image : al.cover;
  img.src = pic ? artUrl(pic, 544) : "/logo.svg";
  const d = $("#herodesc");
  d.hidden = !src.description;
  d.textContent = src.description || "";
  d.classList.remove("open");
  d.title = "Click to read more";
  paintFav();
}
$("#heroby").addEventListener("click", e => {
  const a = e.target.closest(".artlink");
  if (a && a.dataset.id) openPage(a.dataset.id);
});
$("#herodesc").onclick = e => e.currentTarget.classList.toggle("open");
$("#heroplay").onclick = () => {
  const t = S.view.find(x => x.ok);
  if (t) startQueue(S.view, t); else toast("None of these songs can be played.");
};
$("#heroshuf").onclick = () => {
  const ok = S.view.filter(x => x.ok);
  if (!ok.length) return toast("None of these songs can be played.");
  if (!S.shuffle) toggleShuffle();
  startQueue(S.view, ok[Math.floor(Math.random() * ok.length)]);
};

/* ---------- search all of YouTube Music: songs in the list, artists and albums as cards ---------- */
let searchSeq = 0;
async function runSearch(q) {
  q = (q || "").trim();
  if (q.length < 2) return toast("Type at least two characters.");
  const seq = ++searchSeq;
  S.seq++;   // a playlist that is still loading must not draw over the results
  S.q = ""; $("#q").value = "";
  S.scope = "one"; syncScopeButtons();
  store.set("recent", [q, ...store.get("recent", []).filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 12));
  $("#side").classList.remove("open");
  $("#plmeta").textContent = `Searching for “${q}”…`;
  try {
    const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq) return;
    S.results = r;
    showSearch();
  } catch (e) {
    if (seq !== searchSeq) return;
    $("#plmeta").textContent = "Search failed";
    onApiError(e);
  }
}
function showSearch() {
  S.smart = null;
  const r = S.results;
  if (!r) return;
  S.seq++;
  endSelect();
  S.plId = "search";
  pushNav("search");
  showHero(null);
  $("#shelves").innerHTML = shelfSec("Artists", r.artists, true, () => "Artist")
    + shelfSec("Albums", r.albums, false, x => [x.artists, x.year, x.type && x.type !== "Album" ? x.type : ""].filter(Boolean).join(" · "));
  $("#rowshead").textContent = "Songs";
  $("#rowshead").hidden = !r.songs.length;
  $("#plname").textContent = `Search: ${r.q}`;
  $("#plmeta").textContent = `${r.songs.length} songs, ${r.albums.length} albums, ${r.artists.length} artists`;
  S.sig = "search:" + r.q;
  S.tracks = r.songs.map((t, i) => prep(t, i + 1, "", 0, "search"));
  S.q = ""; $("#q").value = "";
  render();
  $("#tracks").scrollTop = 0;
  renderPlaylists();
}

/* ---------- favorite albums (= albums in your YouTube Music library) ---------- */
function setAlbums(list) {
  S.albums = list;
  S.favAlbums = new Set(list.map(a => a.id));
  renderPlaylists();
  paintFav();
}
async function loadAlbums(quiet) {
  try {
    const first = await api(quiet ? "/api/albums?refresh=1" : "/api/albums");
    setAlbums(first.albums);
    if (first.cached) setAlbums((await api("/api/albums?refresh=1")).albums);
  } catch { /* the list stays as it was */ }
}
function paintFav() {
  const b = $("#herofav");
  if (hero.hidden) return;
  const on = !!S.favAlbums && S.favAlbums.has(S.plId);
  b.setAttribute("aria-pressed", String(on));
  b.querySelector("span").textContent = on ? "Favorited" : "Favorite";
  b.title = on ? "Remove from your favorite albums" : "Add to your favorite albums (also adds it to your YouTube Music library)";
}
let favBusy = false;
$("#herofav").onclick = async () => {
  if (!S.favAlbums) { loadAlbums(); return toast("Still reading your albums. Try again in a moment."); }
  if (favBusy || hero.hidden) return;
  favBusy = true;
  const id = S.plId, want = !S.favAlbums.has(id);
  if (want) S.favAlbums.add(id); else S.favAlbums.delete(id);
  paintFav();
  try {
    await api("/api/albumfav", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, favorite: want }) });
    toast(want ? "Added to your favorite albums" : "Removed from your favorite albums");
    const d = await api("/api/albums");   // the server's saved list already has the change
    setAlbums(d.albums);
  } catch (e) {
    if (want) S.favAlbums.delete(id); else S.favAlbums.add(id);
    paintFav();
    if (e.status === 401) onApiError(e); else toast(`Couldn't ${want ? "add" : "remove"} the album: ${e.message}`);
  } finally { favBusy = false; }
};

function applyPlaylist(data) {
  showHero(data);
  if (data.id === "LM") noteLiked(data);
  if (!data.cached) S.allTracks = null;
  const ids = data.tracks.map(t => t.id);
  const sig = data.id + ":" + ids.join();
  $("#plname").textContent = data.title;
  const bad = data.tracks.filter(t => !t.ok).length;
  $("#plmeta").textContent = `${data.byline ? data.byline + " · " : ""}${data.tracks.length} songs${bad ? `, ${bad} unavailable` : ""}, checked ${when(data.checked || data.fetched)}`;
  if (sig === S.sig) return;
  if (S.sig.startsWith(data.id + ":") && S.tracks.length) {   // same playlist, new content: say what changed
    const before = new Set(S.tracks.map(t => t.id)), after = new Set(ids);
    const added = ids.filter(x => !before.has(x)).length, removed = [...before].filter(x => !after.has(x)).length;
    if (added || removed) toast(`Playlist updated: ${added} added, ${removed} removed`);
  }
  S.sig = sig;
  S.tracks = data.tracks.map((t, i) => prep(t, i + 1, "", 0, data.id));
  if (S.scope === "one") render();
}

$("#sync").onclick = async () => {
  if (S.scope === "all") return toast("Sync works on one playlist at a time. Open a playlist first.");
  if (S.plId === "search") return runSearch(S.results && S.results.q);
  const b = $("#sync");
  b.disabled = true; b.textContent = "Syncing…";
  S.sig = "";
  await openPlaylist(S.plId, true);
  b.disabled = false; b.textContent = "Sync";
};
$("#syncall").onclick = async () => {
  if (bgRunning) return toast("Playlists are already updating in the background.");
  const b = $("#syncall"), list = S.playlists;
  b.disabled = true;
  let failed = 0;
  for (let i = 0; i < list.length; i++) {
    b.textContent = `Syncing ${i + 1} of ${list.length}`;
    try { await api(`/api/playlist/${encodeURIComponent(list[i].id)}?refresh=1`); } catch (e) { failed++; if (e.status === 401) { onApiError(e); break; } }
  }
  S.allTracks = null; S.sig = "";
  b.disabled = false; b.textContent = "Sync all playlists";
  toast(failed ? `Synced with ${failed} failed` : "All playlists synced");
  if (S.scope === "all") await showScope(); else if (S.plId === "search") showSearch(); else openPlaylist(S.plId);
};

/* ---------- search, sort, list ---------- */
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const bySource = (a, b) => (a.g - b.g) || (a.n - b.n);
const SORTS = {
  order: bySource,
  title: (a, b) => collator.compare(a.title, b.title) || bySource(a, b),
  artist: (a, b) => collator.compare(a.artists, b.artists) || collator.compare(a.album, b.album) || bySource(a, b),
  album: (a, b) => collator.compare(a.album, b.album) || bySource(a, b),
  short: (a, b) => (a.duration - b.duration) || bySource(a, b),
  long: (a, b) => (b.duration - a.duration) || bySource(a, b),
};

function render() {
  if (!menu.hidden && mAnchor !== dots) closeMenu();   // the row it belonged to is about to be redrawn
  const terms = fold(S.q.trim()).split(/\s+/).filter(Boolean);
  let src = S.scope === "all" ? (S.allTracks || []) : S.tracks;
  if (S.smart) src = src.filter(t => OnionTools.matches(t, S.smart.rules, { fold, liked: S.liked || new Set(), history: store.get("history", []) }));
  const list = (terms.length ? src.filter(t => terms.every(x => t._h.includes(x))) : src.slice()).sort(SORTS[S.sort]);
  S.view = list;
  if (S.sel.size) { const here = new Set(src.map(selKey)); for (const k of S.sel) if (!here.has(k)) S.sel.delete(k); }
  const shown = list.slice(0, LIMIT);
  const over = list.length > shown.length ? `, showing the first ${shown.length}` : "";
  $("#count").textContent = terms.length ? `${list.length} of ${src.length} songs${over}` : `${src.length} songs${over}`;
  const all = S.scope === "all", lk = S.liked;
  $("#rows").innerHTML = shown.length ? shown.map((t, i) => `
    <div class="row${t.ok ? "" : " off"}${S.sel.has(selKey(t)) ? " selected" : ""}" tabindex="0" data-i="${i}" data-id="${esc(t.id || "")}">
      <span class="idx"><span class="num">${t.n}</span><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg><input type="checkbox" class="pick" tabindex="-1" aria-label="Select"${S.sel.has(selKey(t)) ? " checked" : ""}></span>
      <img class="art" loading="lazy" decoding="async" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'" src="${esc(artUrl(t.art, 96))}">
      <span class="main"><span class="title">${hl(t.title, terms)}</span><span class="sub">${artistsHtml(t, terms)}</span></span>
      <span class="alb">${all ? hl(t.pl, terms) : t.album ? `<span class="albtxt" title="Go to this album">${hl(t.album, terms)}</span>` : ""}</span>
      <button class="star${lk && lk.has(t.id) ? " on" : ""}" tabindex="-1" aria-label="Like" title="${lk && lk.has(t.id) ? "Remove from liked songs" : "Add to liked songs"}"><svg viewBox="0 0 24 24"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg></button>
      <button class="rowmenu" tabindex="-1" aria-label="More" aria-haspopup="menu" aria-expanded="false" title="More"><svg viewBox="0 0 24 24"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg></button>
      <span class="dur">${t.ok ? (t.duration ? fmt(t.duration) : "") : "Unavailable"}</span>
    </div>`).join("")
    : `<div class="empty"><b>${terms.length ? "No matches" : all ? "Nothing synced yet" : S.plId === "search" ? "No songs found" : "No songs here"}</b>${
        terms.length ? "Search checks title, artist and album." : all ? "Open playlists or use Sync all playlists, then search across them." : S.plId === "search" ? "Try other words, or look at the albums and artists above." : "This playlist is empty."}</div>`;
  paintSugg();
  markPlaying();
  focusRow();
  paintSel();
  updateHeadActions();
}

/* ---------- suggested songs at the end of a playlist (not on albums, artists or search) ---------- */
const rowList = row => row.closest("#sugg") ? S.sugg : S.view;
let suggSeq = 0;
async function loadSuggest(id, refresh = false) {
  if (isPage(id) || id === "search" || S.scope !== "one") return;
  if (!refresh && S.suggFor === id && S.sugg.length) return paintSugg();
  const seq = ++suggSeq, btn = $("#suggrefresh");
  S.suggFor = id; S.sugg = [];
  btn.disabled = true;
  try {
    const r = await api(`/api/suggest/${encodeURIComponent(id)}${refresh ? "?refresh=1" : ""}`);
    if (seq !== suggSeq) return;
    S.sugg = r.songs.map((t, i) => prep(t, i + 1, "", 0, "suggest"));
  } catch (e) {
    if (seq === suggSeq && e.status === 401) onApiError(e);   // anything else: just no suggestions
  } finally { if (seq === suggSeq) btn.disabled = false; }
  if (seq === suggSeq) paintSugg();
}
function paintSugg() {
  const box = $("#suggbox");
  const show = S.suggFor === S.plId && S.sugg.length && S.scope === "one" && !S.q.trim() && S.plId !== "search" && !isPage(S.plId || "");
  box.hidden = !show;
  if (!show) return;
  const lk = S.liked;
  $("#sugg").innerHTML = S.sugg.map((t, i) => `
    <div class="row${t.ok ? "" : " off"}" tabindex="0" data-i="${i}" data-id="${esc(t.id || "")}">
      <span class="idx"><span class="num">${i + 1}</span><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>
      <img class="art" loading="lazy" decoding="async" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'" src="${esc(artUrl(t.art, 96))}">
      <span class="main"><span class="title">${esc(t.title)}</span><span class="sub">${artistsHtml(t)}</span></span>
      <span class="alb">${t.album ? `<span class="albtxt" title="Go to this album">${esc(t.album)}</span>` : ""}</span>
      <button class="star${lk && lk.has(t.id) ? " on" : ""}" tabindex="-1" aria-label="Like" title="${lk && lk.has(t.id) ? "Remove from liked songs" : "Add to liked songs"}"><svg viewBox="0 0 24 24"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg></button>
      <button class="rowmenu" tabindex="-1" aria-label="More" aria-haspopup="menu" aria-expanded="false" title="More"><svg viewBox="0 0 24 24"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg></button>
      <span class="dur">${t.duration ? fmt(t.duration) : ""}</span>
    </div>`).join("");
}
$("#suggrefresh").onclick = () => loadSuggest(S.plId, true);

/* A song to find after the list is drawn: scroll it into the middle and flash it. */
function focusRow() {
  const f = S.focus;
  if (!f) return;
  S.focus = null;
  if (Date.now() - f.at > 20000) return;
  const row = [...document.querySelectorAll("#tracks .row")].find(r => r.dataset.id === f.id);
  if (!row) return toast("Couldn't find that song in the list. Try Sync, then look again.");
  if (!hero.hidden) { $("#tracks").scrollTop = 0; row.scrollIntoView({ block: "nearest" }); }   // album page: keep the cover in view
  else row.scrollIntoView({ block: "center" });
  row.classList.remove("flash"); void row.offsetWidth; row.classList.add("flash");
}

let raf = 0;
$("#q").addEventListener("input", e => {
  S.q = e.target.value;
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(render);
});
$("#sort").addEventListener("change", e => { S.sort = e.target.value; render(); });

function syncScopeButtons() {
  document.querySelectorAll(".seg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.scope === S.scope)));
}
async function showScope() {
  if (S.scope === "all") {
    S.smart = null;
    if (!S.allTracks) {
      try {
        const d = await api("/api/cached");
        S.allTracks = [];
        d.playlists.forEach((p, g) => p.tracks.forEach((t, i) => S.allTracks.push(prep(t, i + 1, p.title, g, p.id))));
        S.allCount = d.playlists.length;
      } catch (e) { return onApiError(e); }
    }
    showHero(null);
    $("#plname").textContent = "All synced playlists";
    $("#plmeta").textContent = `${S.allCount} playlists, ${S.allTracks.length} songs`;
    render();
  } else {
    if (S.plId === "search") return showSearch();
    const meta = S.playlists.find(p => p.id === S.plId);
    $("#plname").textContent = meta ? meta.title : "Playlist";
    render();
    if (S.plId) openPlaylist(S.plId);
  }
}
document.querySelectorAll(".seg button").forEach(b => b.onclick = () => { S.scope = b.dataset.scope; syncScopeButtons(); showScope(); });

/* ---------- playback ---------- */
$("#tracks").addEventListener("click", e => {
  const row = e.target.closest(".row");
  const t = row && rowList(row)[+row.dataset.i];
  const al = e.target.closest(".artlink");
  if (al) { if (t) goToArtist(t, al.dataset.n); return; }
  if (e.target.closest(".albtxt")) { if (t) goToAlbum(t); return; }
  const mb = e.target.closest(".rowmenu");
  if (mb) { if (t) { if (!menu.hidden && mAnchor === mb) closeMenu(); else mainMenu(t, mb); } return; }
  if (e.target.closest(".star")) { if (t) toggleLike(t); return; }
  if (t && row.closest("#rows") && (S.selecting || e.ctrlKey || e.metaKey || e.shiftKey)) { e.preventDefault(); pickRow(row, t, e.shiftKey); return; }
  if (t && t.ok) startQueue(rowList(row), t);
});
$("#tracks").addEventListener("keydown", e => {
  if (e.key !== "Enter" || e.target.closest(".star, .rowmenu")) return;
  const row = e.target.closest(".row");
  const t = row && rowList(row)[+row.dataset.i];
  if (t && t.ok) startQueue(rowList(row), t);
});

function buildOrder(startIdx) {
  const indices = S.queue.map((_, i) => i);
  if (!S.shuffle) { S.order = indices; return; }
  const rest = indices.filter(i => i !== startIdx);
  S.order = (startIdx >= 0 ? [startIdx] : []).concat(OnionTools.smartOrder(rest, S.queue, {
    mode: store.get("shuffleMode", "balanced"), previous: startIdx >= 0 ? startIdx : null, history: store.get("history", []),
  }));
}

function startQueue(list, t) {
  S.queue = list.filter(x => x.ok);
  const idx = S.queue.indexOf(t);
  buildOrder(idx);
  playPos(S.order.indexOf(idx));
}
/* Slot a song in right after the current one, whatever the shuffle order is. A copy, so a song queued twice stays two entries. */
function playNext(t) { enqueue([t], S.pos + 1, `“${t.title}” will play next`); }
function addToQueue(t) { enqueue([t], S.order.length, `Added “${t.title}” to the queue`); }
function enqueue(list, at, msg) {
  list = list.filter(t => t && t.ok);
  if (!list.length) return;
  if (!S.order.length) { startQueue(list, list[0]); return; }
  const first = S.queue.length;
  S.queue.push(...list.map(t => ({ ...t })));   // copies, so a song queued twice stays two entries
  S.order.splice(at, 0, ...list.map((_, i) => first + i));
  preloadNext(0);
  saveQueue();
  if (!queuePanel.hidden) showQueue();
  toast(msg);
}

/* ---------- remember what was playing, the queue and what played recently ---------- */
const slim = t => { const { id, title, artists, artistList, album, albumId, duration, art, type, pid } = t; return { id, title, artists, artistList, album, albumId, duration, art, type, pid, ok: true }; };
let savedAt = 0, histTimer;
function saveNow(force) {
  if (S.restored || !S.order.length || !S.cur || (!force && Date.now() - savedAt < 4000)) return;   // nothing started this time: keep what is saved
  savedAt = Date.now();
  store.set("now", { t: slim(S.cur), at: Math.floor(audio.currentTime) || 0 });
}
function saveQueue() { store.set("queue", upNext().map(x => slim(x.t))); }
function noteHistory(t) {
  const h = store.get("history", []).filter(x => x.id !== t.id);
  h.unshift({ ...slim(t), playedAt: Date.now() });
  store.set("history", h.slice(0, 100));
}
function restoreNow() {
  const n = store.get("now", null);
  if (!n || !n.t || !n.t.id) return;
  const up = store.get("queue", []).filter(x => x && x.id);
  S.queue = [n.t, ...up]; S.order = S.queue.map((_, i) => i); S.pos = 0; S.cur = n.t;
  S.restored = true; S.resume = { id: n.t.id, at: n.at || 0 };
  showNowPlaying(n.t);
  if (n.at > 2 && n.t.duration) { seek.value = n.at / n.t.duration * 1000; paint(seek); $("#tcur").textContent = fmt(n.at); }
}
addEventListener("pagehide", () => saveNow(true));
function playPos(pos) {
  if (pos < 0 || pos >= S.order.length) return;
  S.pos = pos; S.restored = false;
  const t = S.cur = S.queue[S.order[pos]];
  if (spare._id === t.id && spare.getAttribute("src") && !spare._failed) {
    // this song was already loading in the spare player: swap, so it starts at once
    const old = audio;
    audio = spare; spare = old;
    old.pause(); old.removeAttribute("src"); old.load(); old._id = null;
  } else {
    audio.src = streamUrl(t);
    audio._id = t.id; audio._failed = false;
  }
  const resume = S.resume && S.resume.id === t.id ? S.resume.at : 0;
  S.resume = null;
  if (resume > 2 && !(t.duration && resume > t.duration - 5)) audio.addEventListener("loadedmetadata", () => { audio.currentTime = resume; }, { once: true });
  audio.play().catch(() => { /* a newer song replaced this one */ });
  showPlayState();
  showNowPlaying(t);
  markPlaying();
  preloadNext();
  castSync();
  saveNow(true);
  saveQueue();
  clearTimeout(histTimer);
  histTimer = setTimeout(() => noteHistory(t), 8000);   // only songs that got past the first seconds
  if (!queuePanel.hidden) showQueue();
  if (!lyricsPanel.hidden) showLyrics();
}
function next() {
  if (!S.order.length) return;
  let p = S.pos + 1;
  if (p >= S.order.length) {
    if (S.repeat !== "all") { audio.pause(); audio.currentTime = 0; return; }
    if (S.shuffle) buildOrder(-1);
    p = 0;
  }
  playPos(p);
}
function prev() {
  if (!S.order.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (S.pos > 0) playPos(S.pos - 1);
  else if (S.repeat === "all") playPos(S.order.length - 1);
  else audio.currentTime = 0;
}
function togglePlay() {
  if (S.restored) {   // the song from last time, shown but not loaded yet
    S.restored = false;
    const same = S.order.length === 1 && S.view.find(x => x.ok && x.id === S.cur.id);   // no saved queue: use the list it is in, if it is on screen
    if (same) startQueue(S.view, same); else playPos(S.pos);
    return;
  }
  if (!S.cur) {
    const first = S.view.find(t => t.ok);
    if (first) startQueue(S.view, first);
    return;
  }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

/* Look ahead: load the next song into the spare player while this one plays, and look up the one after. */
const songAt = ahead => {
  let p = S.pos + ahead;
  if (p >= S.order.length) p = (S.repeat === "all" && !S.shuffle) ? p - S.order.length : -1;
  return p >= 0 && p < S.order.length ? S.queue[S.order[p]] : null;
};
let preloadTimer;
function preloadNext(delay = 2500) {
  clearTimeout(preloadTimer);
  preloadTimer = setTimeout(() => {
    const t = songAt(1);
    if (t && spare._id !== t.id) {
      spare._failed = false; spare._id = t.id;
      spare.src = streamUrl(t);   // starts downloading now, but stays paused
      spare.load();
    }
    warmAhead(++warmRun);
  }, delay);
}
/* Look up the songs after the next one, one at a time, and stop if the queue moved on meanwhile. */
let warmRun = 0;
async function warmAhead(run) {
  const from = S.cur;
  let ahead = 2;
  const worker = async () => {   // two of these at a time, matching the two lookups the server runs at once
    while (ahead <= 4) {
      const t = songAt(ahead++);
      if (!t || run !== warmRun || S.cur !== from) return;
      try { await fetch(`/api/warm/${encodeURIComponent(t.id)}`); } catch { return; }
    }
  };
  await Promise.all([worker(), worker()]);
}

/* Pointer rests on a song for a moment: look it up now, so a click starts faster. */
const warmedAt = new Map();
let hoverRow = null, hoverTimer, warmBusy = false;
$("#tracks").addEventListener("mouseover", e => {
  const row = e.target.closest(".row");
  if (row === hoverRow) return;
  hoverRow = row;
  clearTimeout(hoverTimer);
  const t = row && rowList(row)[+row.dataset.i];
  if (!t || !t.ok || Date.now() - (warmedAt.get(t.id) || 0) < 80 * 60 * 1000) return;
  hoverTimer = setTimeout(async () => {
    if (warmBusy) return;
    warmBusy = true; warmedAt.set(t.id, Date.now());
    try { await fetch(`/api/warm/${encodeURIComponent(t.id)}`); } catch { /* ignore */ }
    warmBusy = false;
  }, 400);
});
$("#tracks").addEventListener("mouseleave", () => { hoverRow = null; clearTimeout(hoverTimer); });

function markPlaying() {
  document.querySelectorAll("#tracks .row.playing").forEach(r => r.classList.remove("playing"));
  if (S.cur) document.querySelectorAll(`#tracks .row[data-id="${CSS.escape(S.cur.id)}"]`).forEach(r => r.classList.add("playing"));
}
function showNowPlaying(t) {
  $("#nptitle").textContent = t.title;
  $("#npartist").innerHTML = artistsHtml(t);
  const img = $("#npart");
  img.onerror = () => { img.onerror = null; img.src = "/logo.svg"; };   // no cover or it failed to load: show the logo
  img.src = t.art ? artUrl(t.art, 160) : "/logo.svg";
  document.title = `${t.title} – ${t.artists}`;
  if (mAnchor === dots) closeMenu();
  paintStars();
  $("#tcur").textContent = "0:00";
  $("#tdur").textContent = fmt(t.duration);
  seek.value = 0; paint(seek);
  miniSync();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artists, album: t.album,
      artwork: t.art ? [{ src: artUrl(t.art, 256), sizes: "256x256" }] : [],
    });
  }
}

$("#npartist").addEventListener("click", e => {
  const a = e.target.closest(".artlink");
  if (a && S.cur) goToArtist(S.cur, a.dataset.n);
});

/* seek + time */
const seek = $("#seek"), vol = $("#vol");
let scrubbing = false;
const dur = () => (isFinite(audio.duration) && audio.duration > 0) ? audio.duration : (S.cur ? S.cur.duration : 0);
const paint = el => el.style.setProperty("--p", (el.value / el.max * 100) + "%");
seek.addEventListener("input", () => { scrubbing = true; $("#tcur").textContent = fmt(seek.value / 1000 * dur()); paint(seek); });
seek.addEventListener("change", () => { audio.currentTime = seek.value / 1000 * dur(); scrubbing = false; });
on("timeupdate", () => {
  if (scrubbing) return;
  const d = dur();
  seek.value = d ? audio.currentTime / d * 1000 : 0;
  paint(seek);
  $("#tcur").textContent = fmt(audio.currentTime);
  $("#tdur").textContent = fmt(d);
  saveNow();
  syncLyrics();
  miniTime();
  if ("mediaSession" in navigator && d && isFinite(audio.duration)) {
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d), playbackRate: audio.playbackRate }); } catch { /* not supported */ }
  }
});
on("loadedmetadata", () => { $("#tdur").textContent = fmt(dur()); });

function showPlayState() {
  const playing = !audio.paused;
  $("#ico-play").toggleAttribute("hidden", playing);   // SVG elements have no .hidden property, so use the attribute
  $("#ico-pause").toggleAttribute("hidden", !playing);
  $("#play").setAttribute("aria-label", playing ? "Pause" : "Play");
  $("#play").classList.toggle("loading", playing && audio.readyState < 3);   // pulses while the song is still loading
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  miniSync();
}
on("play", () => { showPlayState(); castSync(); });
on("waiting", showPlayState);
on("canplay", showPlayState);
on("playing", () => {
  S.fails = 0; showPlayState();
  // this song is now flowing, so its lookup is done: start on the next one right away
  const n = songAt(1);
  if (n && spare._id !== n.id) preloadNext(300);
});
on("pause", () => { showPlayState(); castSync(); });
on("seeked", () => castSeeked());
on("ended", () => {
  if (cast.ip) return;   // the speaker decides when a song is over (castPoll)
  if (S.sleepEnd) { sleepOff(); toast("Sleep timer: stopped after the song"); next(); audio.pause(); return; }
  if (S.repeat === "one") { audio.currentTime = 0; audio.play().catch(() => {}); } else next();
});
on("error", async () => {
  const t = S.cur;
  if (!t) return;
  let why = "";
  try { why = (await api(`/api/lasterror/${encodeURIComponent(t.id)}`)).error || ""; } catch { /* ignore */ }
  toast(`Can't play “${t.title}”${why ? ": " + why.slice(0, 160) : ""}`);
  if (++S.fails >= 3) {
    toast("Three songs in a row failed. Look at the console window; yt-dlp may need an update.");
    return;
  }
  setTimeout(() => { if (S.cur === t) next(); }, 900);
});

/* buttons */
$("#play").onclick = togglePlay;
$("#next").onclick = next;
$("#prev").onclick = prev;
$("#menu").onclick = () => $("#side").classList.toggle("open");

function showModes() {
  $("#shuffle").setAttribute("aria-pressed", String(S.shuffle));
  const r = $("#repeat");
  r.setAttribute("aria-pressed", String(S.repeat !== "off"));
  r.setAttribute("aria-label", "Repeat: " + S.repeat);
  $("#rep1").toggleAttribute("hidden", S.repeat !== "one");
}
function toggleShuffle() {
  S.shuffle = !S.shuffle;
  store.set("shuffle", S.shuffle);
  if (S.order.length) {
    const cur = S.order[S.pos];
    buildOrder(cur);
    S.pos = S.order.indexOf(cur);
    preloadNext(300);   // the next song changed, and the current one is already playing
  }
  showModes();
  saveQueue();
  if (!queuePanel.hidden) showQueue();
}
function cycleRepeat() {
  S.repeat = { off: "all", all: "one", one: "off" }[S.repeat];
  store.set("repeat", S.repeat);
  showModes();
}
$("#shuffle").onclick = toggleShuffle;
$("#repeat").onclick = cycleRepeat;

function setVolume() {
  both(el => { el.volume = (vol.value / 100) ** 2; });
  paint(vol);
  castVolume();
  store.set("vol", +vol.value);
  miniSync();
}
vol.addEventListener("input", () => { if (muted) setMuted(false); setVolume(); });
vol.addEventListener("wheel", e => {
  e.preventDefault();
  vol.value = Math.max(0, Math.min(100, +vol.value + (e.deltaY < 0 ? 5 : -5)));
  if (muted) setMuted(false);
  setVolume();
}, { passive: false });

/* media keys + keyboard */
if ("mediaSession" in navigator) {
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* unsupported action */ } };
  h("play", () => audio.play().catch(() => {}));
  h("pause", () => audio.pause());
  h("previoustrack", prev);
  h("nexttrack", next);
  h("seekto", d => { audio.currentTime = d.seekTime; });
  h("seekbackward", () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
  h("seekforward", () => { audio.currentTime += 10; });
}
document.addEventListener("keydown", e => {
  if (e.ctrlKey || e.metaKey || e.altKey || $("#dlg").open) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.key === "Escape" && !menu.hidden) { const a = mAnchor; closeMenu(); a.focus(); return; }
  if (e.key === "Escape" && S.selecting && !typing) { endSelect(); return; }
  if (e.key === "Escape" && e.target.id === "q") { e.target.value = ""; S.q = ""; render(); return; }
  if (typing) return;
  switch (e.key) {
    case " ": e.preventDefault(); togglePlay(); break;
    case "n": next(); break;
    case "p": prev(); break;
    case "s": toggleShuffle(); break;
    case "r": cycleRepeat(); break;
    case "l": likeCurrent(); break;
    case "q": toggleQueue(); break;
    case "m": setMuted(!muted); break;
    case "/": e.preventDefault(); $("#q").focus(); $("#q").select(); break;
    case "ArrowRight": audio.currentTime += 5; break;
    case "ArrowLeft": audio.currentTime = Math.max(0, audio.currentTime - 5); break;
  }
});

/* ---------- liked songs ---------- */
const isLiked = id => !!(S.liked && S.liked.has(id));
function paintStars() {
  document.querySelectorAll("#tracks .row").forEach(row => {
    const b = row.querySelector(".star"), on = isLiked(row.dataset.id);
    if (!b) return;
    b.classList.toggle("on", on);
    b.title = on ? "Remove from liked songs" : "Add to liked songs";
  });
  const b = $("#npstar"), on = !!S.cur && isLiked(S.cur.id);
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
  b.setAttribute("aria-label", on ? "Remove from liked songs" : "Add to liked songs");
  b.title = (on ? "Remove from liked songs" : "Add to liked songs") + " (L)";
}
function noteLiked(data) {
  S.liked = new Set(data.tracks.map(t => t.id));
  paintStars();
}
async function loadLiked() {
  try { noteLiked(await api("/api/playlist/LM")); } catch { /* the star will say so when you press it */ }
}
const likeBusy = new Set();
async function toggleLike(t) {
  if (!t || !t.id) return;
  if (!S.liked) { loadLiked(); return toast("Still reading your liked songs. Try again in a moment."); }
  if (likeBusy.has(t.id)) return;
  likeBusy.add(t.id);
  const want = !isLiked(t.id);
  if (want) S.liked.add(t.id); else S.liked.delete(t.id);
  paintStars();
  try {
    await api("/api/like", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: t.id, liked: want, track: { title: t.title, artists: t.artists, artistList: t.artistList, album: t.album, albumId: t.albumId, duration: t.duration, art: t.art, type: t.type } }),
    });
    mirrorLiked(t, want);
    toast(want ? `Added “${t.title}” to liked songs` : `Removed “${t.title}” from liked songs`);
  } catch (e) {
    if (want) S.liked.delete(t.id); else S.liked.add(t.id);
    paintStars();
    if (e.status === 401) onApiError(e); else toast(`Couldn't ${want ? "like" : "unlike"} the song: ${e.message}`);
  } finally { likeBusy.delete(t.id); }
}
function likeCurrent() {
  if (!S.cur) return toast("Play a song first.");
  toggleLike(S.cur);
}
/* The server already updated its saved copy of Liked songs; do the same for the list on screen. */
function mirrorLiked(t, want) {
  S.allTracks = null;
  if (S.plId !== "LM" || !S.sig.startsWith("LM:")) return;
  const rest = S.tracks.filter(x => x.id !== t.id);
  S.tracks = (want ? [{ ...t, sid: null }, ...rest] : rest).map((x, i) => prep(x, i + 1, "", 0, "LM"));
  S.sig = "LM:" + S.tracks.map(x => x.id).join();
  $("#plmeta").textContent = `${S.tracks.length} songs, checked ${when(Date.now() / 1000)}`;
  if (S.scope === "one") render();
}
$("#npstar").onclick = likeCurrent;
/* liked something in the official app meanwhile? Look again when you come back to this window. */
let likedCheck = 0;
addEventListener("focus", async () => {
  if (!S.liked || Date.now() - likedCheck < 5 * 60 * 1000) return;
  likedCheck = Date.now();
  try {
    const d = await api("/api/playlist/LM?refresh=1");
    noteLiked(d);
    if (S.plId === "LM" && S.scope === "one") applyPlaylist(d);
  } catch { /* try again next time */ }
  loadAlbums(true);
});

/* ---------- the three-dot menus: one in the player bar, one on every row ---------- */
const menu = $("#songmenu"), dots = $("#dots");
let mt = null, mAnchor = dots;   // the song the menu is about, and the button it hangs from
const ICON_STAR = '<svg class="ico-star" viewBox="0 0 24 24"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';
const ICON_LIST = '<svg viewBox="0 0 24 24"><path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z"/></svg>';
const ICON_ALBUM = '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg>';
const ICON_ADD = '<svg viewBox="0 0 24 24"><path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z"/></svg>';
const ICON_NEXT = '<svg viewBox="0 0 24 24"><path d="M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v8l6-4z"/></svg>';
const ICON_QUEUE = '<svg viewBox="0 0 24 24"><path d="M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13 0v-3h-2v3h-3v2h3v3h2v-3h3v-2z"/></svg>';
const ICON_PERSON ='<svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 24 24"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>';
const ICON_REMOVE = '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
function closeMenu() {
  menu.hidden = true;
  mAnchor.setAttribute("aria-expanded", "false");
}
function placeMenu() {
  const r = mAnchor.getBoundingClientRect(), h = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + "px";
  const room = innerHeight - 90 - r.bottom;   // space under a row, not counting the player bar
  if (mAnchor !== dots && room >= h + 8) { menu.style.bottom = "auto"; menu.style.top = (r.bottom + 6) + "px"; }   // rows: under the button when it fits
  else if (r.top > h + 16 || r.top > room) { menu.style.top = "auto"; menu.style.bottom = (innerHeight - r.top + 8) + "px"; }   // otherwise above it
  else { menu.style.bottom = "auto"; menu.style.top = (r.bottom + 6) + "px"; }
}
function showMenu(html) {
  menu.innerHTML = html;
  menu.hidden = false;
  mAnchor.setAttribute("aria-expanded", "true");
  placeMenu();
}
/* track: the song; anchor: the button that was pressed. The player bar menu is about the playing song. */
function mainMenu(track = S.cur, anchor = dots) {
  if (!menu.hidden && anchor !== mAnchor) mAnchor.setAttribute("aria-expanded", "false");
  mt = track; mAnchor = anchor;
  const t = mt, on = !!t && !!t.id && isLiked(t.id), off = t && t.id ? "" : " disabled";
  const inLM = t && t.pid === "LM";
  const canRemove = anchor !== dots && t && t.pid && !inLM && S.playlists.some(p => p.id === t.pid);
  showMenu(`
    ${canRemove ? `<button role="menuitem" data-act="remove" class="danger">${ICON_REMOVE}<span class="t">Remove from playlist</span></button>` : ""}
    ${canRemove && !t.ok ? `<button role="menuitem" data-act="replace"><span class="t">Find replacement…</span></button>` : ""}
    <button role="menuitem" data-act="playnext"${t && t.ok ? "" : " disabled"}>${ICON_NEXT}<span class="t">Play next</span></button>
    <button role="menuitem" data-act="queue"${t && t.ok ? "" : " disabled"}>${ICON_QUEUE}<span class="t">Add to queue</span></button>
    <button role="menuitem" data-act="like" class="${on ? "on" : ""}"${off}>${ICON_STAR}<span class="t">${on ? "Remove from liked songs" : "Add to liked songs"}</span></button>
    <button role="menuitem" data-act="addpl"${off}>${ICON_ADD}<span class="t">Add to playlist</span></button>
    <button role="menuitem" data-act="artist"${off}>${ICON_PERSON}<span class="t">Go to artist</span></button>
    <button role="menuitem" data-act="album"${t && t.id && t.album ? "" : " disabled"}>${ICON_ALBUM}<span class="t">Go to album</span></button>
    <button role="menuitem" data-act="find"${off}>${ICON_LIST}<span class="t">Find in playlists</span></button>
    ${t ? "" : '<div class="cap">Play a song to use these.</div>'}`);
  menu.querySelector("button:not(:disabled)")?.focus();
}
function confirmRemove() {
  const t = mt, pl = S.playlists.find(p => p.id === t.pid);
  const name = (pl && pl.title) || t.pl || "this playlist";
  showMenu(`<div class="cap">Remove “${esc(t.title)}” from “${esc(name)}”? It is removed from the playlist in YouTube Music too.</div>
    <button role="menuitem" data-act="remove-yes" class="danger">${ICON_REMOVE}<span class="t">Remove</span></button>
    <button role="menuitem" data-act="back">${ICON_BACK}<span class="t">Cancel</span></button>`);
  menu.querySelector('[data-act="back"]').focus();
}
const removing = new Set();
async function removeFromPlaylist(t) {
  const key = t.pid + ":" + (t.sid || t.id) + ":" + t.n;
  if (removing.has(key)) return;
  removing.add(key);
  try {
    await api("/api/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ playlist: t.pid, id: t.id || null, sid: t.sid || null, pos: t.n }) });
    if (S.allTracks) { const i = S.allTracks.indexOf(t); if (i >= 0) S.allTracks.splice(i, 1); }
    if (S.plId === t.pid && S.sig.startsWith(t.pid + ":")) {
      const rest = S.tracks.filter(x => x !== t && !(x.n === t.n && x.id === t.id));
      S.tracks = rest.map((x, i) => prep(x, i + 1, "", 0, t.pid));
      S.sig = t.pid + ":" + S.tracks.map(x => x.id).join();
      $("#plmeta").textContent = `${S.tracks.length} songs, checked ${when(Date.now() / 1000)}`;
      const meta = S.playlists.find(p => p.id === t.pid);
      if (meta && /\d/.test(String(meta.count ?? ""))) { meta.count = String(S.tracks.length); renderPlaylists(); }
    }
    render();
    if (S.smart) await openSmart(S.smart.id);
    toast(`Removed “${t.title}” from the playlist`);
  } catch (e) {
    if (e.status === 401) onApiError(e); else toast(`Couldn't remove it: ${e.message}`);
  } finally { removing.delete(key); }
}
async function addMenu() {
  const t = mt;
  if (!t || !t.id) return;
  const head = `<button role="menuitem" data-act="back">${ICON_BACK}<span class="t">Back</span></button><hr>`;
  showMenu(head + '<div class="cap">Looking…</div>');
  menu.querySelector("button")?.focus();
  let has = new Set();
  try { has = new Set((await api(`/api/where/${encodeURIComponent(t.id)}`)).playlists.map(p => p.id)); } catch { /* the server will say if it is a duplicate */ }
  if (menu.hidden || mt !== t) return;
  const lists = S.playlists.filter(p => p.id !== "LM");
  showMenu(head + `<div class="cap">Add “${esc(t.title)}” to:</div>` + (lists.length ? lists.map(p => has.has(p.id)
    ? `<button role="menuitem" data-act="go" data-pl="${esc(p.id)}" title="Already added. Click to jump to the song"><span class="t">${esc(p.title)}</span><span class="n">✓ already added</span></button>`
    : `<button role="menuitem" data-act="addto" data-pl="${esc(p.id)}"><span class="t">${esc(p.title)}</span></button>`).join("") : '<div class="cap">No playlists yet.</div>')
    + `<hr><button role="menuitem" data-act="addnew">${ICON_ADD}<span class="t">New playlist…</span></button>`);
  menu.querySelector('[data-act="addto"]')?.focus();
}
async function addToPlaylist(t, pid) {
  closeMenu();
  const pl = S.playlists.find(p => p.id === pid), name = pl ? pl.title : "the playlist";
  try {
    const r = await api("/api/addtoplaylist", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlist: pid, id: t.id, track: { title: t.title, artists: t.artists, artistList: t.artistList, album: t.album, albumId: t.albumId, duration: t.duration, art: t.art, type: t.type } }) });
    S.allTracks = null;
    if (pid === S.suggFor) S.sugg = S.sugg.filter(x => x.id !== t.id);
    if (S.plId === pid && S.sig.startsWith(pid + ":")) {   // that playlist is on screen: add the row
      S.tracks = [...S.tracks, { ...t, sid: r.sid || null }].map((x, i) => prep(x, i + 1, "", 0, pid));
      S.sig = pid + ":" + S.tracks.map(x => x.id).join();
      $("#plmeta").textContent = `${S.tracks.length} songs, checked ${when(Date.now() / 1000)}`;
      if (S.scope === "one") render();
    }
    if (pl && /\d/.test(String(pl.count ?? ""))) { pl.count = String((parseInt(String(pl.count).replace(/\D/g, ""), 10) || 0) + 1); renderPlaylists(); }
    toast(`Added “${t.title}” to “${name}”`);
  } catch (e) {
    if (e.status === 401) onApiError(e); else toast(e.status === 409 ? `“${t.title}” is already in “${name}”` : `Couldn't add it: ${e.message}`);
  }
}
async function findMenu() {
  const t = mt;
  if (!t || !t.id) return;
  const head = `<button role="menuitem" data-act="back">${ICON_BACK}<span class="t">Back</span></button><hr>`;
  showMenu(head + '<div class="cap">Looking…</div>');
  menu.querySelector("button")?.focus();
  let d;
  try { d = await api(`/api/where/${encodeURIComponent(t.id)}`); }
  catch (e) { if (!menu.hidden) showMenu(head + `<div class="cap">Couldn't look: ${esc(e.message)}</div>`); return; }
  if (menu.hidden || mt !== t) return;
  const items = d.playlists.map(p => `<button role="menuitem" data-act="go" data-pl="${esc(p.id)}"><span class="t">${esc(p.title)}</span><span class="n">#${p.pos}</span></button>`).join("");
  const partial = d.searched < d.total ? `Only ${d.searched} of ${d.total} playlists are saved so far. “Sync all playlists” saves the rest.` : "";
  showMenu(head
    + `<div class="cap">${d.playlists.length ? `In ${d.playlists.length} ${d.playlists.length === 1 ? "playlist" : "playlists"}. Click one to jump to the song.` : "Not found in any saved playlist."}</div>`
    + items + (partial ? `<hr><div class="cap">${partial}</div>` : ""));
  menu.querySelector('[data-act="go"]')?.focus();
}
function openPage(id, focusId) {
  closeMenu();
  S.q = ""; $("#q").value = "";
  S.scope = "one"; syncScopeButtons();
  S.focus = focusId ? { id: focusId, at: Date.now() } : null;
  S.sig = "";
  openPlaylist(id);
  $("#tracks").scrollTop = 0;
}
async function artistsOf(t) {
  const known = (t.artistList || []).filter(a => a.id);
  if (known.length) return known;
  if (!t.id) throw new Error("There's no artist page for this song.");
  const r = await api(`/api/artists/${encodeURIComponent(t.id)}`);   // saved before artist ids were remembered
  t.artistList = r.artists;
  return r.artists;
}
async function goToArtist(t, name) {
  closeMenu();
  if (!t) return;
  let list;
  try {
    if (!(t.artistList || []).some(a => a.id)) toast("Finding the artist…");
    list = await artistsOf(t);
  } catch (e) { return onApiError(e); }
  openPage(((name && list.find(a => a.name === name)) || list[0]).id);
}
async function artistMenu() {
  const t = mt;
  if (!t) return;
  const head = `<button role="menuitem" data-act="back">${ICON_BACK}<span class="t">Back</span></button><hr>`;
  showMenu(head + '<div class="cap">Looking…</div>');
  menu.querySelector("button")?.focus();
  let list;
  try { list = await artistsOf(t); }
  catch (e) { if (!menu.hidden) showMenu(head + `<div class="cap">${esc(e.message)}</div>`); return; }
  if (menu.hidden || mt !== t) return;
  if (list.length === 1) return openPage(list[0].id);
  showMenu(head + list.map(a => `<button role="menuitem" data-act="goartist" data-id="${esc(a.id)}"><span class="t">${esc(a.name)}</span></button>`).join(""));
  menu.querySelector('[data-act="goartist"]')?.focus();
}
async function goToAlbum(t) {
  closeMenu();
  if (!t || !t.id) return;
  let id = t.albumId;
  if (!id) {   // saved before albums were remembered: ask YouTube Music which album this is
    toast("Finding the album…");
    try { id = (await api(`/api/albumid/${encodeURIComponent(t.id)}`)).id; t.albumId = id; }
    catch (e) { return onApiError(e); }
  }
  S.q = ""; $("#q").value = "";
  S.scope = "one"; syncScopeButtons();
  S.focus = { id: t.id, at: Date.now() };
  S.sig = "";
  openPlaylist(id);
}
function jumpTo(pid, vid) {
  closeMenu();
  S.q = ""; $("#q").value = "";
  S.scope = "one"; syncScopeButtons();
  S.focus = { id: vid, at: Date.now() };
  if (S.plId === pid && S.sig.startsWith(pid + ":")) showScope();   // already loaded: just draw it again
  else { S.sig = ""; openPlaylist(pid); }
}
dots.onclick = () => { if (!menu.hidden && mAnchor === dots) closeMenu(); else mainMenu(S.cur, dots); };
menu.addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b || b.disabled || !mt) return;
  const act = b.dataset.act, t = mt;
  if (act === "like") { closeMenu(); toggleLike(t); }
  else if (act === "playnext") { closeMenu(); playNext(t); }
  else if (act === "queue") { closeMenu(); addToQueue(t); }
  else if (act === "album") goToAlbum(t);
  else if (act === "artist") artistMenu();
  else if (act === "goartist") openPage(b.dataset.id);
  else if (act === "addpl") addMenu();
  else if (act === "addto") addToPlaylist(t, b.dataset.pl);
  else if (act === "addnew") { closeMenu(); newPlaylist([t]); }
  else if (act === "find") findMenu();
  else if (act === "back") mainMenu(t, mAnchor);
  else if (act === "replace") { closeMenu(); findReplacement(t); }
  else if (act === "remove") confirmRemove();
  else if (act === "remove-yes") { closeMenu(); removeFromPlaylist(t); }
  else if (act === "go") jumpTo(b.dataset.pl, t.id);
});
menu.addEventListener("keydown", e => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...menu.querySelectorAll("button:not(:disabled)")], i = items.indexOf(document.activeElement);
  items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
});
document.addEventListener("pointerdown", e => {
  if (!menu.hidden && !menu.contains(e.target) && !mAnchor.contains(e.target)) closeMenu();
});
$("#tracks").addEventListener("scroll", () => { if (!menu.hidden && mAnchor !== dots) closeMenu(); }, { passive: true });
addEventListener("resize", () => { if (!menu.hidden) placeMenu(); });

/* remembers the app window's size and position: "Onion Player.vbs" opens the window with these next time.
   Only an app window counts (not a browser tab), and a minimized window is ignored. */
(() => {
  const isApp = matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: minimal-ui)").matches || !window.locationbar.visible;
  if (!isApp) return;
  let last = "";
  const save = () => {
    const x = Math.round(screenX), y = Math.round(screenY), w = Math.round(outerWidth), h = Math.round(outerHeight);
    if (x < -10000 || w < 300 || h < 300) return;
    const maximized = w >= screen.availWidth - 20 && h >= screen.availHeight - 20;
    const key = [x, y, w, h, maximized].join();
    if (key === last) return;
    last = key;
    try { navigator.sendBeacon("/api/window", new Blob([JSON.stringify({ x, y, w, h, maximized })], { type: "application/json" })); } catch { /* not worth a message */ }
  };
  setInterval(save, 3000);
  addEventListener("pagehide", save);
})();

/* tells the server this window is still open (when started with "Onion Player.vbs" it stops itself after the window closes) */
const PAGE = Math.random().toString(36).slice(2);
const ping = () => fetch("/api/ping?p=" + PAGE).catch(() => {});
ping();
setInterval(ping, 20000);
addEventListener("pagehide", () => { try { navigator.sendBeacon("/api/closing?p=" + PAGE); } catch { /* the server stops later anyway */ } });

/* ---------- small dialogs: a name, a choice, a confirmation ---------- */
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
function ask({ title, message = "", input = null, choices = null, ok = "OK", cancel = "Cancel", danger = false, body = null, onBody = null, confirmWord = "" }) {
  return new Promise(resolve => {
    const d = $("#dlg"), inp = $("#dlginput"), okb = $("#dlgok"), list = $("#dlgchoices"), bodyEl = $("#dlgbody");
    $("#dlgtitle").textContent = title;
    $("#dlgmsg").textContent = message; $("#dlgmsg").hidden = !message;
    const showInput = input !== null || !!confirmWord, word = confirmWord.toLowerCase();
    inp.hidden = !showInput;
    if (input) { inp.value = input.value || ""; inp.placeholder = input.placeholder || ""; }
    if (confirmWord) { inp.value = ""; inp.placeholder = `Type ${confirmWord} to confirm`; }
    inp.oninput = confirmWord ? () => { okb.disabled = inp.value.trim().toLowerCase() !== word; } : null;
    list.hidden = !choices;
    list.innerHTML = choices ? choices.map((c, i) => `<button type="button" class="choice" data-i="${i}">${esc(c.label)}</button>`).join("") : "";
    bodyEl.hidden = !body; bodyEl.innerHTML = body || "";
    okb.hidden = !!choices; okb.textContent = ok; okb.classList.toggle("danger", danger); okb.disabled = !!confirmWord;
    $("#dlgcancel").textContent = cancel;
    let result = null;
    const done = v => { result = v; d.close(); };
    list.onclick = e => { const b = e.target.closest(".choice"); if (b) done(choices[+b.dataset.i].value); };
    $("#dlgform").onsubmit = e => { e.preventDefault(); if (confirmWord && inp.value.trim().toLowerCase() !== word) { inp.focus(); return; } if (input !== null && !inp.value.trim()) { inp.focus(); return; } done(input !== null ? inp.value.trim() : true); };
    $("#dlgcancel").onclick = () => done(null);
    d.onclose = () => resolve(result);   // Esc closes it too
    d.showModal();
    if (onBody) onBody(bodyEl);
    (showInput ? inp : choices ? list.querySelector(".choice") || okb : okb).focus();
    if (showInput) inp.select();
  });
}

/* ---------- your playlists: new, rename, delete ---------- */
const ownedPl = id => !!id && id !== "LM" && S.playlists.some(p => p.id === id);
async function newPlaylist(songs = [], name = "") {
  const title = await ask({ title: songs.length ? `New playlist with ${songs.length === 1 ? "this song" : songs.length + " songs"}` : "New playlist", input: { value: name, placeholder: "Playlist name" }, ok: "Create" });
  if (!title) return null;
  try {
    const r = await post("/api/playlist/create", { title, ids: songs.map(t => t.id).filter(Boolean) });
    S.playlists.splice(Math.min(1, S.playlists.length), 0, r);
    S.allTracks = null;
    renderPlaylists();
    toast(r.warning || `Created “${title}” with ${r.count} songs`);
    return r;
  } catch (e) { if (e.status === 401) onApiError(e); else toast(`Couldn't create it: ${e.message}`); return null; }
}
$("#newpl").onclick = async () => {
  const r = await newPlaylist();
  if (r) { S.scope = "one"; syncScopeButtons(); S.sig = ""; openPlaylist(r.id); }
};
$("#plrename").onclick = async () => {
  const p = S.playlists.find(x => x.id === S.plId);
  if (!p) return;
  const title = await ask({ title: "Rename playlist", input: { value: p.title }, ok: "Rename" });
  if (!title || title === p.title) return;
  try {
    await post("/api/playlist/rename", { playlist: p.id, title });
    p.title = title; S.allTracks = null;
    $("#plname").textContent = title;
    renderPlaylists();
    toast("Renamed");
  } catch (e) { if (e.status === 401) onApiError(e); else toast(`Couldn't rename it: ${e.message}`); }
};
$("#pldelete").onclick = async () => {
  const p = S.playlists.find(x => x.id === S.plId);
  if (!p) return;
  if (!await ask({ title: `Delete “${p.title}”?`, message: "It is deleted in YouTube Music too. A backup will be saved first. You can recover it as a new private playlist in Backups & recovery.", ok: "Delete", danger: true, confirmWord: "yes" })) return;
  try {
    await post("/api/playlist/delete", { playlist: p.id, confirmation: "yes" });
    S.playlists = S.playlists.filter(x => x.id !== p.id); S.allTracks = null; S.sig = "";
    toast(`Deleted “${p.title}”`);
    openPlaylist("LM");
  } catch (e) { if (e.status === 401) onApiError(e); else toast(`Couldn't delete it: ${e.message}`); }
};

/* what the buttons in the page header show for the page you are on */
let dupMemo = null;
function dupsOf(tracks) {
  if (dupMemo && dupMemo.tracks === tracks) return dupMemo.res;
  const byId = new Map();
  for (const t of tracks) if (t.id) { if (!byId.has(t.id)) byId.set(t.id, []); byId.get(t.id).push(t); }
  const exact = [...byId.values()].filter(g => g.length > 1);   // the very same song, twice or more
  const names = new Map();   // different entries that look like the same song (another album, a remaster)
  for (const g of byId.values()) {
    const k = fold(g[0].title) + "|" + fold(g[0].artists);
    if (!names.has(k)) names.set(k, []);
    names.get(k).push(g[0]);
  }
  const maybe = [...names.values()].filter(g => g.length > 1);
  dupMemo = { tracks, res: { exact, maybe } };
  return dupMemo.res;
}
function updateHeadActions() {
  const owned = ownedPl(S.plId) && S.scope === "one";
  $("#plrename").hidden = $("#pldelete").hidden = !owned;
  $("#clearhist").hidden = S.plId !== "recent";
  $("#sync").hidden = S.plId === "recent";
  let n = 0;
  if (owned) { const { exact, maybe } = dupsOf(S.tracks); n = [...exact, ...maybe].reduce((a, g) => a + g.length - 1, 0); }
  $("#pldups").hidden = !n;
  $("#pldups").textContent = `Duplicates (${n})`;
  updateFeatureActions();
}

/* ---------- duplicates ---------- */
function applyRemoved(pid, list) {
  const gone = new Set(list);
  S.allTracks = null;
  if (S.plId === pid && S.sig.startsWith(pid + ":")) {
    S.tracks = S.tracks.filter(x => !gone.has(x)).map((x, i) => prep(x, i + 1, "", 0, pid));
    S.sig = pid + ":" + S.tracks.map(x => x.id).join();
    $("#plmeta").textContent = `${S.tracks.length} songs, checked ${when(Date.now() / 1000)}`;
  }
  const meta = S.playlists.find(p => p.id === pid);
  if (meta && /\d/.test(String(meta.count ?? ""))) { meta.count = String(Math.max(0, (parseInt(String(meta.count).replace(/\D/g, ""), 10) || 0) - list.length)); renderPlaylists(); }
  render();
}
let bulkBusy = false;
async function removeTracks(pid, list) {
  if (bulkBusy) return 0;
  bulkBusy = true;
  try {
    toast(`Backing up and removing ${list.length} songs…`);
    const r = await post("/api/removemany", { playlist: pid, items: list.map(t => ({ id: t.id, sid: t.sid || null, pos: t.n })) });
    const confirmed = list.filter(t => r.removedItems.some(x => t.sid ? x.setVideoId === t.sid : x.pos === t.n && x.videoId === t.id));
    applyRemoved(pid, confirmed);
    if (r.error || r.skipped || r.failed) await ask({ title: "Removal result", message: `${r.removed} removed, ${r.skipped} skipped, ${r.failed} not confirmed. ${r.error || "Some entries could not be matched safely."} A backup is available in Backups & recovery.`, ok: "OK" });
    return r.removed;
  } catch (e) { onApiError(e); return 0; }
  finally { bulkBusy = false; }
}

$("#pldups").onclick = () => showDups();

/* ---------- selecting several songs ---------- */
const selKey = t => (t.pid || "") + "|" + (t.id || "") + "|" + t.n;
function paintSel() {
  $("#tracks").classList.toggle("selecting", S.selecting);
  $("#selectbtn").setAttribute("aria-pressed", String(S.selecting));
  $("#selbar").hidden = !S.selecting;
  document.querySelectorAll("#rows .row").forEach(r => {
    const t = S.view[+r.dataset.i], on = !!t && S.sel.has(selKey(t));
    r.classList.toggle("selected", on);
    const c = r.querySelector(".pick");
    if (c) c.checked = on;
  });
  const n = S.sel.size;
  $("#selcount").textContent = n ? `${n} selected` : "Click songs to select them";
  $("#selbar").querySelectorAll("[data-sel]").forEach(b => { b.disabled = !n && ["next", "queue", "add", "remove"].includes(b.dataset.sel); });
  $("#selremove").hidden = !(ownedPl(S.plId) && S.scope === "one");
}
function endSelect() { S.selecting = false; S.sel.clear(); S.lastPick = null; paintSel(); }
function pickRow(row, t, range) {
  const i = +row.dataset.i;
  if (range && S.lastPick !== null) {
    const [a, b] = [S.lastPick, i].sort((x, y) => x - y);
    for (let k = a; k <= b; k++) if (S.view[k]) S.sel.add(selKey(S.view[k]));
  } else {
    const k = selKey(t);
    if (S.sel.has(k)) S.sel.delete(k); else S.sel.add(k);
  }
  S.lastPick = i;
  S.selecting = true;   // starting with Ctrl or Shift click turns select mode on
  paintSel();
}
$("#selectbtn").onclick = () => { if (S.selecting) endSelect(); else { S.selecting = true; paintSel(); } };
async function addManyTo(list) {
  const lists = S.playlists.filter(p => p.id !== "LM" && p.id !== S.plId);
  const n = list.length;
  const pid = await ask({ title: `Add ${n} ${n === 1 ? "song" : "songs"} to`, choices: [...lists.map(p => ({ label: p.title, value: p.id })), { label: "New playlist…", value: "" }] });
  if (pid === null) return;
  if (pid === "") { if (await newPlaylist(list)) endSelect(); return; }
  const pl = S.playlists.find(p => p.id === pid);
  try {
    toast(`Backing up and adding ${list.length} songs…`);
    const r = await post("/api/addmany", { playlist: pid, tracks: list.map(slim) });
    S.allTracks = null;
    if (pl && /\d/.test(String(pl.count ?? ""))) { pl.count = String((parseInt(String(pl.count).replace(/\D/g, ""), 10) || 0) + r.added); renderPlaylists(); }
    if (r.error || r.failed) await ask({ title: "Addition result", message: `${r.added} added, ${r.skipped} skipped, ${r.failed} not confirmed. ${r.error || ""} Sync before retrying.`, ok: "OK" });
    toast(`${r.added} added to “${pl ? pl.title : "the playlist"}”, ${r.skipped} skipped, ${r.failed || 0} not confirmed`);
    endSelect();
  } catch (e) { if (e.status === 401) onApiError(e); else toast(`Couldn't add them: ${e.message}`); }
}
$("#selbar").onclick = async e => {
  const b = e.target.closest("[data-sel]");
  if (!b || b.disabled) return;
  const list = S.view.filter(t => S.sel.has(selKey(t))), n = list.length, word = n === 1 ? "song" : "songs";
  switch (b.dataset.sel) {
    case "all":
      if (S.sel.size >= S.view.length) S.sel.clear(); else S.view.forEach(t => S.sel.add(selKey(t)));
      paintSel(); break;
    case "done": endSelect(); break;
    case "next": enqueue(list, S.pos + 1, `${n} ${word} will play next`); endSelect(); break;
    case "queue": enqueue(list, S.order.length, `Added ${n} ${word} to the queue`); endSelect(); break;
    case "add": await addManyTo(list); break;
    case "remove": {
      const pl = S.playlists.find(p => p.id === S.plId);
      if (!await ask({ title: `Remove ${n} ${word}?`, message: `They are removed from “${pl ? pl.title : "the playlist"}” in YouTube Music too.`, ok: "Remove", danger: true })) break;
      const done = await removeTracks(S.plId, list);
      if (done) { toast(`Removed ${done} ${done === 1 ? "song" : "songs"}`); endSelect(); }
      break;
    }
  }
};

/* ---------- recently played ---------- */
function showRecent() {
  S.smart = null;
  S.seq++;
  endSelect();
  S.plId = "recent";
  pushNav("recent");
  showHero(null);
  $("#suggbox").hidden = true;
  $("#side").classList.remove("open");
  const h = store.get("history", []);
  $("#plname").textContent = "Recently played";
  $("#plmeta").textContent = `${h.length} ${h.length === 1 ? "song" : "songs"}, newest first`;
  S.sig = "recent:" + h.map(t => t.id).join();
  S.tracks = h.map((t, i) => prep(t, i + 1, "", 0, "recent"));
  S.q = ""; $("#q").value = "";
  render();
  $("#tracks").scrollTop = 0;
  renderPlaylists();
}
$("#clearhist").onclick = async () => {
  if (!await ask({ title: "Clear recently played?", ok: "Clear", danger: true })) return;
  store.set("history", []);
  showRecent();
};

/* ---------- popups next to the player bar ---------- */
function placeAbove(panel, btn) {
  const r = btn.getBoundingClientRect();
  panel.style.top = "auto";
  panel.style.bottom = (innerHeight - r.top + 8) + "px";
  panel.style.left = Math.max(8, Math.min(r.left, innerWidth - panel.offsetWidth - 8)) + "px";
}

/* ---------- sleep timer ---------- */
const sleepBtn = $("#sleepbtn"), sleepPanel = $("#sleeppanel");
let sleepTimer = null, sleepAt = 0;
function updateSleep() {
  const on = !!(S.sleepEnd || sleepAt);
  sleepBtn.setAttribute("aria-pressed", String(on));
  sleepBtn.title = on ? `Sleep timer: stops ${S.sleepEnd ? "after this song" : `in about ${Math.max(1, Math.round((sleepAt - Date.now()) / 60000))} min`}` : "Sleep timer";
}
function sleepOff() { clearTimeout(sleepTimer); sleepTimer = null; sleepAt = 0; S.sleepEnd = false; updateSleep(); }
function setSleep(min) {
  sleepOff();
  if (min === "end") S.sleepEnd = true;
  else if (min) { sleepAt = Date.now() + min * 60000; sleepTimer = setTimeout(() => { sleepOff(); audio.pause(); toast("Sleep timer: paused"); }, min * 60000); }
  updateSleep();
  toast(min === "end" ? "Will stop after this song" : min ? `Will pause in ${min} minutes` : "Sleep timer off");
}
setInterval(updateSleep, 30000);
function closeSleep() { sleepPanel.hidden = true; sleepBtn.setAttribute("aria-expanded", "false"); }
sleepBtn.onclick = () => {
  if (!sleepPanel.hidden) return closeSleep();
  closeQueue(); closeLyrics();
  const on = !!(S.sleepEnd || sleepAt);
  sleepPanel.innerHTML = '<div class="cap">Pause playback</div>'
    + [15, 30, 45, 60].map(m => `<button role="menuitem" data-m="${m}"><span class="t">In ${m} minutes</span></button>`).join("")
    + '<button role="menuitem" data-m="end"><span class="t">After this song</span></button>'
    + (on ? '<hr><button role="menuitem" data-m="0" class="danger"><span class="t">Turn off the timer</span></button>' : "");
  sleepPanel.hidden = false;
  placeAbove(sleepPanel, sleepBtn);
  sleepBtn.setAttribute("aria-expanded", "true");
  sleepPanel.querySelector("button")?.focus();
};
sleepPanel.addEventListener("click", e => {
  const b = e.target.closest("button[data-m]");
  if (!b) return;
  closeSleep();
  setSleep(b.dataset.m === "end" ? "end" : +b.dataset.m);
});
document.addEventListener("pointerdown", e => { if (!sleepPanel.hidden && !sleepPanel.contains(e.target) && !sleepBtn.contains(e.target)) closeSleep(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !sleepPanel.hidden) { closeSleep(); sleepBtn.focus(); } });

/* ---------- lyrics ---------- */
const lyricsPanel = $("#lyricspanel"), lyricsBody = $("#lyricsbody"), lyricsBtn = $("#lyricsbtn");
let lyricsTimed = null, lyricsAt = -1, lyricsFor = null;
async function showLyrics() {
  const t = S.cur;
  lyricsTimed = null; lyricsAt = -1;
  $("#lyricstitle").textContent = t ? `${t.title} · ${t.artists}` : "Lyrics";
  if (!t || !t.id) { lyricsBody.innerHTML = '<div class="cap">Play a song to see its lyrics.</div>'; return; }
  lyricsFor = t.id;
  lyricsBody.innerHTML = '<div class="cap">Looking…</div>';
  let d = {};
  try { d = await api(`/api/lyrics/${encodeURIComponent(t.id)}`); }
  catch (e) { if (lyricsFor === t.id && !lyricsPanel.hidden) lyricsBody.innerHTML = `<div class="cap">Couldn't look them up: ${esc(e.message)}</div>`; return; }
  if (lyricsFor !== t.id || lyricsPanel.hidden) return;
  const src = d.source ? `<div class="lysrc">${esc(d.source)}</div>` : "";
  if (d.lines) {
    lyricsTimed = d.lines;
    lyricsBody.innerHTML = d.lines.map((l, i) => `<p class="ly" data-i="${i}">${esc(l.text) || "&nbsp;"}</p>`).join("") + src;
    syncLyrics();
  } else if (d.text) lyricsBody.innerHTML = `<p class="lytext">${esc(d.text)}</p>` + src;
  else lyricsBody.innerHTML = '<div class="cap">No lyrics found for this song.</div>';
}
function syncLyrics() {
  if (!lyricsTimed || lyricsPanel.hidden) return;
  const ms = audio.currentTime * 1000;
  let i = -1;
  for (let k = 0; k < lyricsTimed.length && lyricsTimed[k].t <= ms; k++) i = k;
  if (i === lyricsAt) return;
  lyricsAt = i;
  lyricsBody.querySelector(".ly.on")?.classList.remove("on");
  const p = lyricsBody.querySelector(`.ly[data-i="${i}"]`);
  if (p) { p.classList.add("on"); p.scrollIntoView({ block: "center", behavior: "smooth" }); }
}
function closeLyrics() { lyricsPanel.hidden = true; lyricsBtn.setAttribute("aria-pressed", "false"); }
lyricsBtn.onclick = () => {
  if (!lyricsPanel.hidden) return closeLyrics();
  closeQueue(); closeSleep();
  lyricsPanel.hidden = false;
  lyricsBtn.setAttribute("aria-pressed", "true");
  showLyrics();
};
$("#lyricsclose").onclick = closeLyrics;
lyricsBody.addEventListener("click", e => {
  const p = e.target.closest(".ly");
  if (p && lyricsTimed) audio.currentTime = lyricsTimed[+p.dataset.i].t / 1000;
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && !lyricsPanel.hidden && menu.hidden) closeLyrics(); });

/* ---------- show the playing song in its list ---------- */
$("#locatebtn").onclick = async () => {
  const t = S.cur;
  if (!t) return toast("Nothing is playing.");
  if (S.view.some(x => x.id === t.id)) { S.focus = { id: t.id, at: Date.now() }; render(); return; }
  if (t.pid && S.playlists.some(p => p.id === t.pid)) return jumpTo(t.pid, t.id);
  try {
    const d = await api(`/api/where/${encodeURIComponent(t.id)}`);
    if (d.playlists.length) return jumpTo(d.playlists[0].id, t.id);
  } catch { /* fall through to the message */ }
  toast("This song isn't in any of your saved playlists.");
};

/* ---------- the queue: what plays after the current song ---------- */
const queuePanel = $("#queuepanel"), queueBtn = $("#queuebtn");
let queueVisible = 200;
const ICON_SHUFFLE = '<svg viewBox="0 0 24 24"><path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>';
const upNext = () => S.order.slice(S.pos + 1).map((qi, k) => ({ t: S.queue[qi], at: S.pos + 1 + k }));
function reshuffle() {
  const rest = S.order.splice(S.pos + 1);   // what is still to come; the song playing and the ones before it stay
  S.order.push(...OnionTools.smartOrder(rest, S.queue, { mode: store.get("shuffleMode", "balanced"), previous: S.order[S.pos], history: store.get("history", []) }));
  preloadNext(0);
  saveQueue();
  showQueue();
  toast("Shuffled what's left");
}
function saveQueueAsPlaylist() {
  const songs = [S.cur, ...upNext().map(x => x.t)].filter(t => t && t.ok);
  closeQueue();
  if (!songs.length) return toast("The queue is empty.");
  newPlaylist(songs, `Queue ${new Date().toLocaleDateString()}`);
}
function showQueue() {
  const keep = queuePanel.querySelector(".qlist")?.scrollTop || 0;
  const list = upNext(), cur = S.cur;
  const now = cur ? `<div class="cap">Now playing</div><div class="qrow now"><span class="t">${esc(cur.title)}<small>${esc(cur.artists)}</small></span></div>` : "";
  const rows = list.slice(0, queueVisible).map(({ t, at }) => `<div class="qrow" draggable="true" data-at="${at}">
      <button class="qplay" title="Play now. Drag to move"><span class="t">${esc(t.title)}<small>${esc(t.artists)}</small></span></button>
      <button class="ib qtop" title="Move to the top" aria-label="Move to the top"><svg viewBox="0 0 24 24"><path d="M4 4h16v2H4zm8 4-7 7h5v5h4v-5h5z"/></svg></button>
      <button class="ib qdel" title="Remove from the queue" aria-label="Remove from the queue"><svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
    </div>`).join("");
  const acts = (S.shuffle && list.length > 1 ? `<button class="qshuffle" data-a="reshuffle" title="Shuffle the songs that are left">${ICON_SHUFFLE}<span>Reshuffle</span></button>` : "")
    + (cur ? `<button class="qshuffle" data-a="save" title="Save the queue as a playlist">${ICON_ADD}<span>Save</span></button>` : "");
  queuePanel.innerHTML = `<div class="qhead"><span>Queue</span><span class="qacts">${acts}</span></div><div class="qlist">${now}<div class="cap">Up next${list.length ? ` (${list.length})` : ""}</div>`
    + (rows || '<div class="cap">Nothing queued. Use “Play next” or “Add to queue” in a song’s menu.</div>') + (list.length > queueVisible ? `<button class="ghost" data-morequeue>Show next ${Math.min(200, list.length - queueVisible)} (${list.length - queueVisible} more)</button>` : "") + "</div>";
  queuePanel.querySelector(".qlist").scrollTop = keep;
}
function openQueue() {
  queueVisible = 200;
  closeMenu(); closeSleep(); closeLyrics();
  showQueue();
  queuePanel.hidden = false;
  queueBtn.setAttribute("aria-expanded", "true");
}
function closeQueue() { queuePanel.hidden = true; queueBtn.setAttribute("aria-expanded", "false"); }
function toggleQueue() { if (queuePanel.hidden) openQueue(); else closeQueue(); }
queueBtn.onclick = toggleQueue;
queuePanel.addEventListener("click", e => {
  if (e.target.closest("[data-morequeue]")) { queueVisible += 200; showQueue(); return; }
  const a = e.target.closest(".qshuffle");
  if (a) return a.dataset.a === "save" ? saveQueueAsPlaylist() : reshuffle();
  const row = e.target.closest(".qrow[data-at]");
  if (!row) return;
  const at = +row.dataset.at;
  if (e.target.closest(".qdel")) {
    S.order.splice(at, 1);
    preloadNext(0);
  } else if (e.target.closest(".qtop")) {
    S.order.splice(S.pos + 1, 0, ...S.order.splice(at, 1));
    preloadNext(0);
  } else if (e.target.closest(".qplay")) { playPos(at); return; }
  saveQueue();
  showQueue();
});
/* drag a song to a new place in the queue */
let dragFrom = null;
const dropSide = (row, e) => { const b = row.getBoundingClientRect(); return e.clientY > b.top + b.height / 2; };
const clearDrop = () => queuePanel.querySelectorAll(".drop-above, .drop-below, .dragging").forEach(r => r.classList.remove("drop-above", "drop-below", "dragging"));
queuePanel.addEventListener("dragstart", e => {
  const row = e.target.closest(".qrow[data-at]");
  if (!row) return;
  dragFrom = +row.dataset.at;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", String(dragFrom));
  row.classList.add("dragging");
});
queuePanel.addEventListener("dragover", e => {
  const row = e.target.closest(".qrow[data-at]");
  if (dragFrom === null || !row) return;
  e.preventDefault();
  queuePanel.querySelectorAll(".drop-above, .drop-below").forEach(r => r.classList.remove("drop-above", "drop-below"));
  row.classList.add(dropSide(row, e) ? "drop-below" : "drop-above");
});
queuePanel.addEventListener("drop", e => {
  const row = e.target.closest(".qrow[data-at]");
  if (dragFrom === null || !row) return;
  e.preventDefault();
  let to = +row.dataset.at + (dropSide(row, e) ? 1 : 0);
  const [moved] = S.order.splice(dragFrom, 1);
  if (dragFrom < to) to--;
  S.order.splice(to, 0, moved);
  dragFrom = null;
  preloadNext(0);
  saveQueue();
  showQueue();
});
queuePanel.addEventListener("dragend", () => { dragFrom = null; clearDrop(); });
document.addEventListener("pointerdown", e => {
  if (!queuePanel.hidden && !queuePanel.contains(e.target) && !queueBtn.contains(e.target)) closeQueue();
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && !queuePanel.hidden) { closeQueue(); queueBtn.focus(); } });

/* ---------- mute ---------- */
let muted = store.get("muted", false);
function setMuted(m) {
  muted = !!m;
  both(el => { el.muted = muted || cast.ip !== ""; });
  if (cast.ip) castCmd("mute", muted ? 1 : 0);
  const b = $("#mutebtn");
  b.setAttribute("aria-pressed", String(muted));
  b.title = muted ? "Unmute (M)" : "Mute (M)";
  b.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  const [on, off] = b.querySelectorAll("svg");
  on.toggleAttribute("hidden", muted); off.toggleAttribute("hidden", !muted);
  store.set("muted", muted);
  miniSync();
}
$("#mutebtn").onclick = () => setMuted(!muted);

/* ---------- Sonos: the speaker plays, this page keeps its own (silent) player running as the clock ---------- */
const castBtn = $("#castbtn"), castPanel = $("#castpanel");
const castCmd = (cmd, value) => {
  // volume and mute belong to each speaker; everything else goes through the leader
  const to = cmd === "volume" || cmd === "mute" ? cast.ips.map(s => s.ip) : [cast.ip];
  return Promise.all(to.map(ip => post("/api/sonos/cmd", { ip, cmd, value }))).catch(e => { toast(e.message); });
};
function castShow() {
  castBtn.setAttribute("aria-pressed", String(!!cast.ip));
  castBtn.title = cast.ip ? `Playing on ${cast.name} (click to change)` : "Play on Sonos";
}
let castTimer;
function castSync() {
  if (!cast.ip) return;
  clearTimeout(castTimer);
  castTimer = setTimeout(async () => {   // a song change pauses and plays within a moment: send only where it ended up
    if (!cast.ip || !S.cur || S.restored) return;
    const playing = !audio.paused, id = audio._id || S.cur.id;
    try {
      if (id !== cast.id) {
        if (!playing) return;
        cast.id = id; cast.playing = true; cast.heard = false; cast.since = Date.now();
        await post("/api/sonos/play", { ip: cast.ip, id, title: `${S.cur.title} - ${S.cur.artists}`, position: audio.currentTime });
      } else if (playing !== cast.playing) {
        cast.playing = playing;
        await castCmd(playing ? "play" : "pause");
      }
    } catch (e) {
      toast(e.message || "Sonos did not answer");
      castStop(true);
    }
  }, 150);
}
function castSeeked() {
  if (!cast.ip || !cast.id) return;
  if (cast.nudge) { cast.nudge = false; return; }
  castCmd("seek", audio.currentTime);
}
function castVolume() {
  if (!cast.ip) return;
  clearTimeout(cast.volTimer);
  cast.volTimer = setTimeout(() => { cast.volTimer = null; castCmd("volume", +vol.value); }, 120);
}
async function castPoll() {
  if (!cast.ip || cast.busy || !cast.id) return;
  cast.busy = true;
  try {
    const st = await api(`/api/sonos/state?ip=${encodeURIComponent(cast.ip)}`);
    if (st.id !== cast.id && cast.playing && Date.now() - cast.since > 8000) { castStop(false); toast(`${cast.name} is playing something else, so Onion Player let go`); return; }
    if (st.state === "PLAYING" && st.id === cast.id) {
      cast.heard = true;
      if (!cast.playing) { cast.playing = true; audio.play().catch(() => {}); }   // resumed from the Sonos app
      if (!scrubbing && Math.abs(audio.currentTime - st.pos) > 3) { cast.nudge = true; audio.currentTime = st.pos; }
    } else if (st.state === "PAUSED_PLAYBACK" && cast.heard && cast.playing) {
      cast.playing = false; audio.pause();   // paused from the Sonos app
    } else if (st.state === "STOPPED" && cast.heard && cast.playing && Date.now() - cast.since > 5000) {
      cast.heard = false;   // finished
      if (S.sleepEnd) { sleepOff(); toast("Sleep timer: stopped after the song"); next(); audio.pause(); }
      else if (S.repeat === "one") { cast.id = ""; audio.currentTime = 0; castSync(); }
      else next();
    }
    if (!cast.volTimer && Math.abs(st.volume - +vol.value) > 1) { vol.value = st.volume; paint(vol); store.set("vol", st.volume); }
  } catch { /* a missed answer is fine, the next poll tries again */ }
  cast.busy = false;
}
function castNames() { return cast.ips.map(s => s.name).join(" + "); }
async function castSetSpeakers(ips) {
  // The first speaker leads; the others are grouped with it in Sonos, so they play in sync.
  const old = cast.ips;
  if (!ips.length) return castStop(false);
  if (!old.length) {
    castStop(true);
    Object.assign(cast, { ip: ips[0].ip, ips, name: "", id: "", playing: false, heard: false });
    both(el => { el.muted = true; });
    cast.timer = setInterval(castPoll, 2000);
  }
  const leaderChanged = old.length && old[0].ip !== ips[0].ip;
  cast.ips = ips; cast.ip = ips[0].ip; cast.name = castNames();
  castShow();
  try {
    await post("/api/sonos/group", { ips: ips.map(s => s.ip), removed: old.filter(o => !ips.some(s => s.ip === o.ip)).map(s => s.ip) });
  } catch (e) { toast(e.message); }
  castVolume();
  if (leaderChanged) { cast.id = ""; cast.heard = false; }   // another speaker leads now: start the song there, at this position
  if (!old.length || leaderChanged) { if (!audio.paused) castSync(); }
}
function castStop(silent) {
  if (!cast.ip) return;
  const ips = cast.ips.map(s => s.ip);
  clearInterval(cast.timer);
  post("/api/sonos/cmd", { ip: ips[0], cmd: "pause" }).catch(() => {});
  if (ips.length > 1) post("/api/sonos/group", { ips: [ips[0]], removed: ips.slice(1) }).catch(() => {});
  cast.ip = ""; cast.ips = []; cast.id = ""; cast.playing = false;
  both(el => { el.muted = muted; });
  castShow();
  if (!silent) toast("Playing on this computer again");
}
function closeCast() { castPanel.hidden = true; castBtn.setAttribute("aria-expanded", "false"); }
let castList = [];
function drawCast() {
  castPanel.innerHTML = '<div class="cap">Play on… (pick one or more)</div>'
    + (cast.ip ? '<button role="menuitem" data-ip=""><span class="t">This computer</span></button>' : "")
    + castList.map(s => `<button role="menuitemcheckbox" aria-checked="${cast.ips.some(x => x.ip === s.ip)}" data-ip="${esc(s.ip)}" data-name="${esc(s.name)}"><span class="t">${cast.ips.some(x => x.ip === s.ip) ? "✓ " : ""}${esc(s.name)}</span></button>`).join("")
    + (castList.length ? "" : '<div class="cap">No Sonos speakers found on this network.</div>')
    + '<hr><button role="menuitem" data-refresh="1"><span class="t">Search again</span></button>';
  placeAbove(castPanel, castBtn);
}
async function openCast(refresh) {
  castPanel.innerHTML = '<div class="cap">Play on…</div><div class="cap">Looking for speakers…</div>';
  castPanel.hidden = false; placeAbove(castPanel, castBtn); castBtn.setAttribute("aria-expanded", "true");
  try { castList = (await api("/api/sonos/speakers" + (refresh ? "?refresh=1" : ""))).speakers; }
  catch (e) { castPanel.innerHTML = `<div class="cap">${esc(e.message)}</div>`; placeAbove(castPanel, castBtn); return; }
  drawCast();
  castPanel.querySelector("button")?.focus();
}
castBtn.onclick = () => {
  if (!castPanel.hidden) return closeCast();
  closeQueue(); closeLyrics(); closeSleep();
  openCast(false);
};
castPanel.addEventListener("click", async e => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.refresh) return openCast(true);
  if (b.dataset.ip === "") { closeCast(); const t = audio.currentTime; castStop(false); audio.currentTime = t; return; }
  const ip = b.dataset.ip;
  const ips = cast.ips.some(s => s.ip === ip) ? cast.ips.filter(s => s.ip !== ip) : [...cast.ips, { ip, name: b.dataset.name }];
  const t = audio.currentTime;
  await castSetSpeakers(ips);
  if (!ips.length) audio.currentTime = t;
  drawCast();
});
document.addEventListener("pointerdown", e => { if (!castPanel.hidden && !castPanel.contains(e.target) && !castBtn.contains(e.target)) closeCast(); });

/* ---------- mini player: a second small app window, steered through the server ---------- */
const mini = { open: false, pushedAt: 0, launched: 0, pumping: false };
function miniState() {
  const t = S.cur;
  return { title: t ? t.title : "Nothing playing", artist: t ? t.artists : "", art: t && t.art ? artUrl(t.art, 160) : "/logo.svg",
    playing: !audio.paused, muted, vol: +vol.value, pos: audio.currentTime || 0, dur: dur(), at: Date.now() };
}
function miniSync() {
  if (!mini.open) return;
  mini.pushedAt = Date.now();
  post("/api/mini/push", miniState()).catch(() => {});
}
function miniTime() { if (mini.open && Date.now() - mini.pushedAt > 900) miniSync(); }
function runMiniCmd(c) {
  if (c.cmd === "play") togglePlay();
  else if (c.cmd === "prev") prev();
  else if (c.cmd === "next") next();
  else if (c.cmd === "mute") setMuted(!muted);
  else if (c.cmd === "volume" && typeof c.value === "number") { vol.value = Math.max(0, Math.min(100, c.value)); if (muted && c.value > 0) setMuted(false); setVolume(); }
  else if (c.cmd === "seek" && typeof c.value === "number") audio.currentTime = c.value / 1000 * dur();
}
async function miniPump() {
  if (mini.pumping) return;
  mini.pumping = true;
  try {
    while (mini.open) {
      const r = await api("/api/mini/commands?wait=20");   // waits on the server, so a minimized window is not slowed down
      r.cmds.forEach(runMiniCmd);
      if (r.ready && !r.open) mini.open = false;   // it was open and now it is gone
      else if (!r.ready && Date.now() - mini.launched > 10000) mini.open = false;   // it never came up
    }
  } catch { mini.open = false; }
  mini.pumping = false;
  $("#minibtn").setAttribute("aria-pressed", String(mini.open));
}
function miniAttach() {
  mini.open = true; mini.launched = Date.now();
  $("#minibtn").setAttribute("aria-pressed", "true");
  miniSync();
  miniPump();
}
$("#minibtn").onclick = async () => {
  try {
    if (mini.open && (await post("/api/mini/close", {})).wasOpen) return;   // otherwise the page was out of date: open a new one
    const r = await post("/api/mini/open", {});
    if (!r.ok) return;
    miniAttach();
  } catch (e) { toast(`Couldn't open the mini player: ${e.message}`); }
};
api("/api/mini/alive").then(r => { if (r.open) miniAttach(); }).catch(() => {});   // the window was already open when this page loaded


/* ---------- start ---------- */
function bootPlayer() {
vol.value = store.get("vol", 80);
setVolume();
setMuted(muted);
showModes();
showPlayState();
restoreNow();
(async () => {
  try {
    const st = await api("/api/status");
    if (!st.authenticated) showSetup(); else loadPlaylists();
  } catch (e) { toast("Can't reach the Onion server. Is the console window still open?"); }
})();
}

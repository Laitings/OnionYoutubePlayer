"use strict";
const $ = (s, r = document) => r.querySelector(s);
const A1 = $("#audio"), A2 = $("#audio2");
let audio = A1, spare = A2;   // two players: one plays while the other preloads the next song
const both = f => [A1, A2].forEach(f);
const on = (evt, fn) => both(el => el.addEventListener(evt, e => { if (el === audio) fn(e); }));   // only the active player counts
both(el => el.addEventListener("error", () => { el._failed = true; }));
const streamUrl = t => `/api/audio/${encodeURIComponent(t.id)}`;
const LIMIT = 2500;   // most rows drawn at once; search narrows it down

const store = {
  get(k, d) { try { const v = localStorage.getItem("onion." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("onion." + k, JSON.stringify(v)); } catch { /* storage can be blocked */ } },
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
function renderPlaylists() {
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
  $("#playlists").innerHTML = S.playlists.filter(p => !f || fold(p.title).includes(f)).map(p => {
    const n = String(p.count ?? "").match(/\d[\d.,]*/);
    return `<button class="pl${p.id === S.plId ? " active" : ""}" data-id="${esc(p.id)}"><span class="t">${esc(p.title)}</span><span class="n">${n ? esc(n[0]) : ""}</span></button>`;
  }).join("");
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
  const r = S.results;
  if (!r) return;
  S.seq++;
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
  const src = S.scope === "all" ? (S.allTracks || []) : S.tracks;
  const list = (terms.length ? src.filter(t => terms.every(x => t._h.includes(x))) : src.slice()).sort(SORTS[S.sort]);
  S.view = list;
  const shown = list.slice(0, LIMIT);
  const over = list.length > shown.length ? `, showing the first ${shown.length}` : "";
  $("#count").textContent = terms.length ? `${list.length} of ${src.length} songs${over}` : `${src.length} songs${over}`;
  const all = S.scope === "all", lk = S.liked;
  $("#rows").innerHTML = shown.length ? shown.map((t, i) => `
    <div class="row${t.ok ? "" : " off"}" tabindex="0" data-i="${i}" data-id="${esc(t.id || "")}">
      <span class="idx"><span class="num">${t.n}</span><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>
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
  if (t && t.ok) startQueue(rowList(row), t);
});
$("#tracks").addEventListener("keydown", e => {
  if (e.key !== "Enter" || e.target.closest(".star, .rowmenu")) return;
  const row = e.target.closest(".row");
  const t = row && rowList(row)[+row.dataset.i];
  if (t && t.ok) startQueue(rowList(row), t);
});

function buildOrder(startIdx) {
  const n = S.queue.length;
  S.order = [...Array(n).keys()];
  if (!S.shuffle) return;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [S.order[i], S.order[j]] = [S.order[j], S.order[i]];
  }
  if (startIdx >= 0) {
    const k = S.order.indexOf(startIdx);
    [S.order[0], S.order[k]] = [S.order[k], S.order[0]];
  }
}
function startQueue(list, t) {
  S.queue = list.filter(x => x.ok);
  const idx = S.queue.indexOf(t);
  buildOrder(idx);
  playPos(S.order.indexOf(idx));
}
/* Slot a song in right after the current one, whatever the shuffle order is. A copy, so a song queued twice stays two entries. */
function playNext(t) { enqueue(t, S.pos + 1, `“${t.title}” will play next`); }
function addToQueue(t) { enqueue(t, S.order.length, `Added “${t.title}” to the queue`); }
function enqueue(t, at, msg) {
  if (!t || !t.ok) return;
  if (!S.order.length) { startQueue([t], t); return; }
  S.queue.push({ ...t });
  S.order.splice(at, 0, S.queue.length - 1);
  preloadNext(0);
  if (!queuePanel.hidden) showQueue();
  toast(msg);
}

/* ---------- remember what was playing, so the next start shows it again ---------- */
let savedAt = 0;
function saveNow(force) {
  if (!S.order.length || !S.cur || (!force && Date.now() - savedAt < 4000)) return;   // nothing started this time: keep what is saved
  savedAt = Date.now();
  const { id, title, artists, artistList, album, albumId, duration, art, type } = S.cur;
  store.set("now", { t: { id, title, artists, artistList, album, albumId, duration, art, type, ok: true }, at: Math.floor(audio.currentTime) || 0 });
}
function restoreNow() {
  const n = store.get("now", null);
  if (!n || !n.t || !n.t.id) return;
  S.cur = n.t; S.resume = { id: n.t.id, at: n.at || 0 };
  showNowPlaying(n.t);
  if (n.at > 2 && n.t.duration) { seek.value = n.at / n.t.duration * 1000; paint(seek); $("#tcur").textContent = fmt(n.at); }
}
addEventListener("pagehide", () => saveNow(true));
function playPos(pos) {
  if (pos < 0 || pos >= S.order.length) return;
  S.pos = pos;
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
  saveNow(true);
  if (!queuePanel.hidden) showQueue();
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
  if (S.cur && !S.order.length) {   // the song from last time, shown but not loaded yet: queue the list it is in, if it is on screen
    const same = S.view.find(x => x.ok && x.id === S.cur.id);
    startQueue(same ? S.view : [S.cur], same || S.cur);
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
}
on("play", showPlayState);
on("waiting", showPlayState);
on("canplay", showPlayState);
on("playing", () => {
  S.fails = 0; showPlayState();
  // this song is now flowing, so its lookup is done: start on the next one right away
  const n = songAt(1);
  if (n && spare._id !== n.id) preloadNext(300);
});
on("pause", showPlayState);
on("ended", () => {
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
  store.set("vol", +vol.value);
}
vol.addEventListener("input", setVolume);

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
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.key === "Escape" && !menu.hidden) { const a = mAnchor; closeMenu(); a.focus(); return; }
  if (e.key === "Escape" && e.target.id === "q") { e.target.value = ""; S.q = ""; render(); return; }
  if (typing) return;
  switch (e.key) {
    case " ": e.preventDefault(); togglePlay(); break;
    case "n": next(); break;
    case "p": prev(); break;
    case "s": toggleShuffle(); break;
    case "r": cycleRepeat(); break;
    case "l": likeCurrent(); break;
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
    : `<button role="menuitem" data-act="addto" data-pl="${esc(p.id)}"><span class="t">${esc(p.title)}</span></button>`).join("") : '<div class="cap">No playlists yet.</div>'));
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
  else if (act === "find") findMenu();
  else if (act === "back") mainMenu(t, mAnchor);
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
const ping = () => fetch("/api/ping").catch(() => {});
ping();
setInterval(ping, 20000);

/* ---------- start ---------- */
vol.value = store.get("vol", 80);
setVolume();
showModes();
showPlayState();
restoreNow();
(async () => {
  try {
    const st = await api("/api/status");
    if (!st.authenticated) showSetup(); else loadPlaylists();
  } catch (e) { toast("Can't reach the Onion server. Is the console window still open?"); }
})();

/* ---------- the queue: what plays after the current song ---------- */
const queuePanel = $("#queuepanel"), queueBtn = $("#queuebtn");
const ICON_SHUFFLE = '<svg viewBox="0 0 24 24"><path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>';
const upNext = () => S.order.slice(S.pos + 1).map((qi, k) => ({ t: S.queue[qi], at: S.pos + 1 + k }));
function reshuffle() {
  const rest = S.order.splice(S.pos + 1);   // what is still to come; the song playing and the ones before it stay
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  S.order.push(...rest);
  preloadNext(0);
  showQueue();
  toast("Shuffled what's left");
}
function showQueue() {
  const keep = queuePanel.querySelector(".qlist")?.scrollTop || 0;
  const list = upNext(), cur = S.cur;
  const now = cur ? `<div class="cap">Now playing</div><div class="qrow now"><span class="t">${esc(cur.title)}<small>${esc(cur.artists)}</small></span></div>` : "";
  const rows = list.slice(0, 200).map(({ t, at }) => `<div class="qrow" data-at="${at}">
      <button class="qplay" title="Play now"><span class="t">${esc(t.title)}<small>${esc(t.artists)}</small></span></button>
      <button class="ib qtop" title="Move to the top" aria-label="Move to the top"><svg viewBox="0 0 24 24"><path d="M4 4h16v2H4zm8 4-7 7h5v5h4v-5h5z"/></svg></button>
      <button class="ib qdel" title="Remove from the queue" aria-label="Remove from the queue"><svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
    </div>`).join("");
  const reshuffleBtn = S.shuffle && list.length > 1
    ? `<button class="qshuffle" title="Shuffle the songs that are left">${ICON_SHUFFLE}<span>Reshuffle</span></button>` : "";
  queuePanel.innerHTML = `<div class="qhead"><span>Queue</span>${reshuffleBtn}</div><div class="qlist">${now}<div class="cap">Up next${list.length ? ` (${list.length})` : ""}</div>`
    + (rows || '<div class="cap">Nothing queued. Use “Play next” or “Add to queue” in a song’s menu.</div>') + "</div>";
  queuePanel.querySelector(".qlist").scrollTop = keep;
}
function openQueue() {
  closeMenu();
  showQueue();
  queuePanel.hidden = false;
  queueBtn.setAttribute("aria-expanded", "true");
}
function closeQueue() { queuePanel.hidden = true; queueBtn.setAttribute("aria-expanded", "false"); }
queueBtn.onclick = () => { if (queuePanel.hidden) openQueue(); else closeQueue(); };
queuePanel.addEventListener("click", e => {
  if (e.target.closest(".qshuffle")) return reshuffle();
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
  showQueue();
});
document.addEventListener("pointerdown", e => {
  if (!queuePanel.hidden && !queuePanel.contains(e.target) && !queueBtn.contains(e.target)) closeQueue();
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && !queuePanel.hidden) { closeQueue(); queueBtn.focus(); } });

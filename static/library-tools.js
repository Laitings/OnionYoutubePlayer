"use strict";

/* Library organization and saved rules stay local to this browser profile. */
function paintLibrary(filter) {
  const prefs = store.get("libraryPrefs", {});
  const lists = S.playlists.filter(p => !filter || fold(`${p.title} ${prefs[p.id]?.folder || ""}`).includes(filter));
  const row = p => `<button class="pl${S.plId === p.id ? " active" : ""}" data-id="${esc(p.id)}"><span class="t">${prefs[p.id]?.pinned ? "★ " : ""}${esc(p.title)}</span><span class="n">${esc(p.count ?? "")}</span></button>`;
  const pinned = lists.filter(p => prefs[p.id]?.pinned);
  const unfiled = lists.filter(p => !prefs[p.id]?.pinned && !prefs[p.id]?.folder);
  const folders = new Map();
  for (const p of lists.filter(p => !prefs[p.id]?.pinned && prefs[p.id]?.folder)) {
    const folder = prefs[p.id].folder;
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(p);
  }
  const views = store.get("smartViews", []).filter(v => !filter || fold(v.name).includes(filter));
  $("#playlists").innerHTML = recentEntry(filter)
    + (views.length ? '<div class="sidecap">Smart playlists · local</div>' + views.map(v => `<button class="sr smartview" data-smart="${esc(v.id)}">◇ ${esc(v.name)}</button>`).join("") : "")
    + (pinned.length ? '<div class="sidecap">Pinned</div>' + pinned.map(row).join("") : "")
    + unfiled.map(row).join("")
    + [...folders].sort(([a], [b]) => collator.compare(a, b)).map(([folder, items]) => `<details class="folder"${store.get("closedFolders", []).includes(folder) && !filter ? "" : " open"}><summary>${esc(folder)} <small>${items.length}</small></summary>${items.map(row).join("")}</details>`).join("");
  $("#playlists").querySelectorAll(".folder").forEach(d => d.addEventListener("toggle", () => {
    const name = d.querySelector("summary").childNodes[0].textContent.trim();
    const closed = new Set(store.get("closedFolders", []));
    if (d.open) closed.delete(name); else closed.add(name);
    store.set("closedFolders", [...closed]);
  }));
}
$("#playlists").addEventListener("click", e => {
  const b = e.target.closest("[data-smart]");
  if (b) openSmart(b.dataset.smart);
});

function updateFeatureActions() {
  const own = ownedPl(S.plId) && S.scope === "one";
  $("#organizebtn").hidden = !own;
  const unavailable = own ? S.tracks.filter(t => !t.ok).length : 0;
  $("#replacebtn").hidden = !unavailable;
  $("#replacebtn").textContent = `Find replacements (${unavailable})`;
  if (S.smart) $("#sync").hidden = true;
}
$("#organizebtn").onclick = async () => {
  const id = S.plId, p = S.playlists.find(p => p.id === id);
  if (!p) return;
  const prefs = store.get("libraryPrefs", {}), pref = prefs[id] || {};
  let next;
  const go = await ask({ title: `Organize “${p.title}”`, message: "Folders and pins are saved on this computer in this browser profile.", ok: "Save", body: `
    <label class="field"><span>Folder (leave blank for no folder)</span><input id="foldername" type="text" maxlength="80" value="${esc(pref.folder || "")}"></label>
    <label class="checkfield"><input id="pinpl" type="checkbox"${pref.pinned ? " checked" : ""}> Pin at the top</label>`,
    onBody: body => { next = () => ({ folder: $("#foldername", body).value.trim(), pinned: $("#pinpl", body).checked }); },
  });
  if (go) { prefs[id] = next(); store.set("libraryPrefs", prefs); renderPlaylists(); }
};

async function allSavedTracks() {
  const d = await api("/api/cached");
  return d.playlists.flatMap((p, g) => p.tracks.map((t, i) => prep(t, i + 1, p.title, g, p.id)));
}
async function openSmart(id) {
  const view = store.get("smartViews", []).find(v => v.id === id);
  if (!view) return toast("That saved search no longer exists.");
  const seq = ++S.seq;
  try {
    if (view.rules.liked && !S.liked) await loadLiked();
    const tracks = await allSavedTracks();
    if (seq !== S.seq) return;
    endSelect(); S.smart = view; S.plId = "smart:" + id; S.scope = "one";
    S.q = ""; $("#q").value = ""; S.tracks = tracks; S.sig = "smart:" + id;
    pushNav(S.plId); showHero(null); syncScopeButtons();
    $("#suggbox").hidden = true;
    $("#plname").textContent = view.name;
    $("#plmeta").textContent = "Smart playlist · based on synced playlists · rules update when reopened";
    $("#side").classList.remove("open"); render(); renderPlaylists();
  } catch (e) { onApiError(e); }
}
async function editSmart(existing = null) {
  const rules = existing?.rules || { query: S.q, playlist: S.scope === "one" && ownedPl(S.plId) ? S.plId : "" };
  let read;
  const go = await ask({ title: existing ? "Edit smart playlist" : "Save search / smart playlist", ok: "Save", message: "A local view of synced songs. Genre words match playlist names, titles and albums; this does not infer genres.", body: `
    <label class="field"><span>Name</span><input id="svname" type="text" maxlength="100" value="${esc(existing?.name || S.q || "My smart playlist")}"></label>
    <label class="field"><span>Search words</span><input id="svquery" type="text" maxlength="200" value="${esc(rules.query || "")}"></label>
    <label class="field"><span>Artist contains</span><input id="svartist" type="text" maxlength="100" value="${esc(rules.artist || "")}"></label>
    <label class="field"><span>Source playlist</span><select id="svsource"><option value="">All synced playlists</option>${S.playlists.map(p => `<option value="${esc(p.id)}"${p.id === rules.playlist ? " selected" : ""}>${esc(p.title)}</option>`).join("")}</select></label>
    <label class="field"><span>Maximum length in minutes (0 = any)</span><input id="svminutes" type="number" min="0" max="1440" step="0.5" value="${Number(rules.maxMinutes) || 0}"></label>
    <label class="checkfield"><input id="svliked" type="checkbox"${rules.liked ? " checked" : ""}> Only liked songs</label>
    <label class="checkfield"><input id="svunheard" type="checkbox"${rules.unheard ? " checked" : ""}> Exclude songs in Recently played (last 100)</label>`,
    onBody: body => { read = () => ({ id: existing?.id || crypto.randomUUID(), name: $("#svname", body).value.trim(), rules: {
      query: $("#svquery", body).value.trim(), artist: $("#svartist", body).value.trim(), playlist: $("#svsource", body).value,
      maxMinutes: Math.max(0, Math.min(1440, Number($("#svminutes", body).value) || 0)),
      liked: $("#svliked", body).checked, unheard: $("#svunheard", body).checked,
    } }); },
  });
  if (!go) return;
  const v = read();
  if (!v.name) return toast("A saved search needs a name.");
  store.set("smartViews", [...store.get("smartViews", []).filter(x => x.id !== v.id), v]);
  S.tab = "playlists"; store.set("tab", S.tab); renderPlaylists(); await openSmart(v.id);
}
$("#savesearch").onclick = () => editSmart(S.smart || null);
$("#smartbtn").onclick = async () => {
  const views = store.get("smartViews", []);
  const id = await ask({ title: "Smart playlists", choices: [{ label: "New smart playlist…", value: "new" }, ...views.map(v => ({ label: v.name, value: v.id }))] });
  if (id === null) return;
  if (id === "new") return editSmart();
  const view = views.find(v => v.id === id);
  const action = await ask({ title: view.name, choices: [{ label: "Open", value: "open" }, { label: "Edit rules", value: "edit" }, { label: "Remove this local view…", value: "remove" }] });
  if (action === "open") openSmart(id);
  if (action === "edit") editSmart(view);
  if (action === "remove" && await ask({ title: `Remove “${view.name}”?`, message: "Only this local saved search is removed. No YouTube playlist is changed.", ok: "Remove" })) {
    store.set("smartViews", views.filter(v => v.id !== id));
    if (S.smart?.id === id) { S.smart = null; openPlaylist("LM"); }
    renderPlaylists();
  }
};

$("#shuffleoptions").onclick = async () => {
  const mode = await ask({ title: "Shuffle options", message: "Balanced avoids consecutive songs by the same artist where possible. Discovery also favors songs outside Recently played, then older plays. History covers the last 100 distinct songs in this browser.", choices: [
    { label: "Balanced · spread artists apart", value: "balanced" }, { label: "Discovery · unheard or older plays first", value: "discovery" }, { label: "Fully random", value: "random" },
  ] });
  if (!mode) return;
  store.set("shuffleMode", mode);
  if (S.shuffle && S.order.length) reshuffle();
  toast(`Shuffle mode: ${mode}`);
};

/* Preview audio is separate from the queue and does not alter listening history. */
const previewAudio = $("#preview");
let previewResume = false;
function previewSong(t) {
  if (!t?.id || !t.ok) return;
  previewResume ||= !audio.paused;
  audio.pause();
  if (previewAudio.dataset.id === t.id && !previewAudio.paused) { previewAudio.pause(); return; }
  previewAudio.dataset.id = t.id; previewAudio.src = streamUrl(t);
  previewAudio.play().catch(() => toast("Could not preview this version."));
}
function stopPreview() {
  previewAudio.pause(); previewAudio.removeAttribute("src"); previewAudio.load();
  if (previewResume) audio.play().catch(() => {});
  previewResume = false;
}
previewAudio.addEventListener("error", () => toast("Could not load this preview. Try another version."));

async function showDups() {
  const pid = S.plId, keep = new Map();
  while (S.plId === pid) {
    const { exact, maybe } = dupsOf(S.tracks);
    if (!exact.length && !maybe.length) return;
    let removeOne = null;
    const groups = [...exact.map((g, i) => ({ g, key: "exact" + i, exact: true })), ...maybe.map((g, i) => ({ g, key: "maybe" + i, exact: false }))];
    for (const { g, key } of groups) if (!g.some(t => selKey(t) === keep.get(key))) keep.set(key, selKey(g[0]));
    const body = groups.map(({ g, key, exact: same }) => `<section class="dgroup"><div class="dcap">${same ? "Same song id" : "Possible alternate versions · compare before removing"}</div><div class="dname">${esc(g[0].title)} <span class="dby">${esc(g[0].artists)}</span></div>${g.map(t => `<div class="dcopy">
      <label class="keepchoice"><input type="radio" name="${key}" data-keep="${key}" value="${esc(selKey(t))}"${keep.get(key) === selKey(t) ? " checked" : ""}> Keep #${t.n}</label>
      <span class="dtxt" title="${esc(t.album)}">${esc(t.album || "No album")} · ${fmt(t.duration)}</span>
      <button type="button" class="ghost" data-preview="${esc(selKey(t))}"${t.ok ? "" : " disabled"}>Listen</button>
      <button type="button" class="ghost" data-remove="${esc(selKey(t))}" data-group="${key}"${keep.get(key) === selKey(t) ? " disabled" : ""}>Remove</button></div>`).join("")}</section>`).join("");
    const extras = exact.reduce((n, g) => n + g.length - 1, 0);
    const go = await ask({ title: "Compare duplicates", message: "Choose which copy to keep in each group. Listen compares versions without replacing your queue. Bulk cleanup only removes extras with exactly the same song id; alternate versions are always reviewed individually.", body,
      ok: extras ? `Remove ${extras} exact extras…` : "Close", cancel: "Close", onBody: el => {
        el.onchange = e => {
          if (!e.target.dataset.keep) return;
          keep.set(e.target.dataset.keep, e.target.value);
          el.querySelectorAll("[data-remove]").forEach(b => { b.disabled = keep.get(b.dataset.group) === b.dataset.remove; });
        };
        el.onclick = e => {
          const b = e.target.closest("button");
          if (!b || b.disabled) return;
          const t = S.tracks.find(t => selKey(t) === (b.dataset.preview || b.dataset.remove));
          if (b.dataset.preview) previewSong(t);
          if (b.dataset.remove) { removeOne = t; $("#dlg").close(); }
        };
      },
    });
    stopPreview();
    const list = removeOne ? [removeOne] : go && extras ? groups.filter(x => x.exact).flatMap(({ g, key }) => g.filter(t => selKey(t) !== keep.get(key))) : [];
    if (!list.length) return;
    if (await ask({ title: `Remove ${list.length} ${list.length === 1 ? "copy" : "copies"}?`, message: "The selected copies are removed in YouTube Music too. A complete backup is saved first.", ok: "Remove", danger: true })) {
      const n = await removeTracks(pid, list); toast(`Removed ${n} copies. Backup available in Backups & recovery.`);
    }
  }
}

$("#replacebtn").onclick = async () => {
  const bad = S.tracks.filter(t => !t.ok);
  const k = await ask({ title: "Find an available version", message: "Choose an unavailable song to search for alternatives.", choices: bad.map((t, i) => ({ label: `#${t.n} ${t.title || "Unavailable song"} · ${t.artists}`, value: i })) });
  if (k !== null) findReplacement(bad[k]);
};
async function findReplacement(original) {
  const query = await ask({ title: "Search for an alternative", message: `Original: ${original.title || "Unavailable song"} · ${original.artists || "unknown artist"}`, input: { value: `${original.title} ${original.artists}`.trim() }, ok: "Search" });
  if (!query) return;
  let results;
  try { results = (await api(`/api/search?q=${encodeURIComponent(query)}&songs=15&albums=1&artists=1`)).songs.filter(t => t.ok && t.id !== original.id); }
  catch (e) { return onApiError(e); }
  if (!results.length) return toast("No alternative found. Try a shorter title or another artist name.");
  let chosen = null;
  await ask({ title: "Compare available versions", message: "Listen first, then choose a version. Nothing in the playlist changes until you confirm.", ok: "Close", body: results.map((t, i) => `<div class="candidate"><strong>${esc(t.title)}</strong><div>${esc(t.artists)} · ${esc(t.album)} · ${fmt(t.duration)}</div><button type="button" class="ghost" data-listen="${i}">Listen</button> <button type="button" class="ghost" data-choose="${i}">Choose this version</button></div>`).join(""),
    onBody: body => { body.onclick = e => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.listen !== undefined) previewSong(results[+b.dataset.listen]);
      if (b.dataset.choose !== undefined) { chosen = results[+b.dataset.choose]; $("#dlg").close(); }
    }; },
  });
  stopPreview();
  if (!chosen) return;
  const canReplace = original.sid && original.id;
  if (!await ask({ title: canReplace ? "Replace this entry?" : "Add alternative?", message: canReplace
    ? `Replace “${original.title}” with “${chosen.title}” by ${chosen.artists} (${fmt(chosen.duration)}) at the same position. A backup is saved first.`
    : "YouTube did not provide enough information to remove the unavailable entry safely. The alternative will be added at the end; remove the old entry in YouTube Music.", ok: canReplace ? "Replace" : "Add alternative" })) return;
  try {
    if (canReplace) await post("/api/replace", { playlist: original.pid, sid: original.sid, replacement: chosen.id });
    else await post("/api/addtoplaylist", { playlist: original.pid, id: chosen.id, track: chosen });
    S.allTracks = null; S.sig = "";
    await openPlaylist(original.pid, true);
    toast(canReplace ? "Replaced the unavailable entry. A backup is available." : "Added the alternative; original entry kept.");
  } catch (e) { onApiError(e); }
}

$("#backupsbtn").onclick = showBackups;
async function showBackups() {
  try {
    const listing = (await api("/api/backups")).backups;
    const own = ownedPl(S.plId) ? S.plId : null;
    let action = null;
    await ask({ title: "Backups & recovery", message: "Fresh snapshots of the entries YouTube returns are saved before playlist edits. If its reported count is higher than the returned entries, deletion is blocked. Recovery creates a NEW PRIVATE playlist, preserving the saved order and duplicate entries where YouTube allows them. It never overwrites the original. Entries without a video id cannot be recreated. Download snapshots to keep a separate copy.", ok: "Close", body:
      (own ? '<button type="button" class="ghost" data-backup-now>Back up current playlist now</button>' : "")
      + (!listing.length ? '<p>No backups yet. They appear here before your first playlist edit.</p>' : listing.map((b, i) => `<div class="candidate"><strong>${esc(b.title)}</strong><div>${when(b.created)} · ${b.count} songs${b.reportedCount > b.count ? ` (YouTube reports ${b.reportedCount}; some entries were not returned)` : ""} · ${esc(b.reason)}</div><button type="button" class="ghost" data-recover="${i}">${i === 0 ? "Recover latest snapshot as a copy…" : "Recover as a copy…"}</button> <a href="/api/backups/${encodeURIComponent(b.key)}" download>Download JSON</a></div>`).join("")),
      onBody: body => { body.onclick = e => {
        const b = e.target.closest("button"); if (!b) return;
        if (b.hasAttribute("data-backup-now")) action = { kind: "backup" };
        if (b.dataset.recover !== undefined) action = { kind: "restore", item: listing[+b.dataset.recover] };
        if (action) $("#dlg").close();
      }; },
    });
    if (action?.kind === "backup") {
      toast("Saving playlist snapshot…");
      const r = await post("/api/backup", { playlist: own }); toast(`Saved ${r.count} songs in a local backup.`);
      return showBackups();
    }
    if (action?.kind === "restore") {
      const b = action.item;
      if (!await ask({ title: `Recover “${b.title}”?`, message: `Create a new private playlist from this snapshot of ${b.count} entries. The existing playlist stays as it is.`, ok: "Create recovered copy" })) return;
      toast("Creating recovered copy…");
      const r = await post("/api/restore", { key: b.key });
      S.playlists.splice(1, 0, r); S.scope = "one"; S.sig = "";
      renderPlaylists(); await openPlaylist(r.id);
      await ask({ title: "Recovered copy created", message: `${r.count} songs created. ${r.unavailable} entries had no video id and could not be recreated. ${r.notReturned || 0} entries were counted by YouTube but were not returned in the snapshot. ${r.warning || "The original playlist was not overwritten."}`, ok: "OK" });
    }
  } catch (e) { onApiError(e); }
}

/* The player bar grows taller in narrow windows, so the popups follow its height. */
new ResizeObserver(() => {
  document.documentElement.style.setProperty("--player-height", $("#player").offsetHeight + "px");
}).observe($("#player"));
bootPlayer();

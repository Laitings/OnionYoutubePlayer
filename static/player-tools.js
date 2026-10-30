/* Pure ordering and filtering helpers, shared by the player and regression tests. */
(function (root) {
  "use strict";
  function shuffled(items, random = Math.random) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  function smartOrder(indices, tracks, { mode = "balanced", previous = null, history = [], random = Math.random } = {}) {
    if (mode === "random") return shuffled(indices, random);
    const lastPlayed = new Map(history.map(t => [t.id, t.playedAt || Date.now()]));
    const artist = i => String(tracks[i]?.artists || "").trim().toLowerCase();
    const groups = new Map();
    for (const i of shuffled(indices, random)) {
      const key = artist(i);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    }
    if (mode === "discovery") for (const g of groups.values()) g.sort((a, b) => (lastPlayed.get(tracks[a].id) || 0) - (lastPlayed.get(tracks[b].id) || 0));
    let prev = previous == null ? "" : artist(previous);
    const out = [];
    while (groups.size) {
      let choices = [...groups.entries()].filter(([key]) => key !== prev);
      if (!choices.length) choices = [...groups.entries()];
      // Large artist groups go first to avoid leaving an avoidable streak at the end.
      choices.sort((a, b) => mode === "discovery"
        ? ((lastPlayed.get(tracks[a[1][0]].id) || 0) - (lastPlayed.get(tracks[b[1][0]].id) || 0)) || b[1].length - a[1].length
        : b[1].length - a[1].length);
      const [key, group] = choices[0];
      out.push(group.shift()); prev = key;
      if (!group.length) groups.delete(key);
    }
    return out;
  }
  function matches(t, rules, { fold, liked = new Set(), history = [] }) {
    const words = fold(rules.query || "").trim().split(/\s+/).filter(Boolean);
    const hay = fold(`${t.title} ${t.artists} ${t.album} ${t.pl || ""}`);
    return words.every(w => hay.includes(w))
      && (!rules.artist || fold(t.artists).includes(fold(rules.artist)))
      && (!rules.playlist || t.pid === rules.playlist)
      && (!rules.liked || liked.has(t.id))
      && (!rules.maxMinutes || (t.duration > 0 && t.duration <= rules.maxMinutes * 60))
      && (!rules.unheard || !history.some(h => h.id === t.id));
  }
  const api = { shuffled, smartOrder, matches };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OnionTools = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

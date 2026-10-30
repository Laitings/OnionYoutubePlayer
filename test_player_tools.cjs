const assert = require("node:assert/strict");
const { smartOrder, matches } = require("./static/player-tools.js");
const tracks = Array.from({ length: 1200 }, (_, i) => ({ id: String(i), artists: "Artist " + (i % 6) }));
const indices = tracks.map((_, i) => i);
for (const mode of ["balanced", "discovery", "random"]) {
  const order = smartOrder(indices, tracks, { mode });
  assert.equal(order.length, 1200);
  assert.equal(new Set(order).size, 1200);
  if (mode === "balanced") for (let i = 1; i < order.length; i++) assert.notEqual(tracks[order[i]].artists, tracks[order[i - 1]].artists);
}
const older = smartOrder([0, 1, 2], tracks, { mode: "discovery", history: [{ id: "0", playedAt: 200 }, { id: "1", playedAt: 100 }] });
assert.deepEqual(older, [2, 1, 0]);
const fold = s => String(s).toLowerCase();
const song = { id: "1", title: "Road", artists: "Dolly", album: "Hits", pl: "Country", pid: "PL1", duration: 180 };
assert(matches(song, { query: "country", liked: true, maxMinutes: 4 }, { fold, liked: new Set(["1"]) }));
assert(!matches(song, { unheard: true }, { fold, history: [{ id: "1" }] }));
assert(!matches(song, { maxMinutes: 2 }, { fold }));
assert(!matches(song, { playlist: "PL2" }, { fold }));
console.log("Player ordering and smart playlist tests passed.");

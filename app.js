const GENRES = ["Shoegaze", "Dreampop", "Post-rock", "Post-metal", "Blackgaze", "Black metal",
  "Deathcore", "Death metal", "Slowcore", "Drone / Experimental"];
const STALE_HOURS = 30; // daily job + slack; older than this means something broke

// ---- per-device state ----
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem("rr:" + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("rr:" + k, JSON.stringify(v)); } catch {} },
};
let saved = store.get("saved", {});      // key -> release object (survives server-side pruning)
let skipped = new Set(store.get("skipped", []));
let heard = new Set(store.get("heard", []));
let chosen = new Set(store.get("genres", []));
let tab = "new";
let releases = [];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const ICON = {
  save: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M5 3h10v14l-5-3.5L5 17z"/></svg>',
  skip: '<svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 4l10 10M14 4L4 14"/></svg>',
};

function art(r, size = 2) {
  const id = r.bandcamp?.art_id || (r.bandcamp?.art || "").match(/img\/a?(\d+)_/)?.[1];
  return id ? `https://f4.bcbits.com/img/a${id}_${size}.jpg` : null;
}
function ago(iso) {
  const h = (Date.now() - new Date(iso)) / 36e5;
  return h < 24 ? `${Math.max(1, Math.round(h))}h ago` : `${Math.round(h / 24)}d ago`;
}
function dayLabel(iso) {
  const d = new Date(iso), today = new Date();
  const diff = Math.floor((new Date(today.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

// ---- status line: the "is it actually working?" signal ----
function renderStatus(status) {
  const el = $("#status");
  if (!status?.finished) { el.className = "status stale"; el.textContent = "no update data"; return; }
  const hours = (Date.now() - new Date(status.finished)) / 36e5;
  const time = new Date(status.finished).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const warn = status.ok === false ? " · warn" : "";
  if (hours > STALE_HOURS) { el.className = "status stale"; el.textContent = `stale · last run ${ago(status.finished)}`; }
  else { el.className = "status"; el.textContent = `${time} · +${status.new_in_feed ?? 0}${warn}`; }
  el.title = `Last run ${new Date(status.finished).toLocaleString()}`;
}

// ---- filtering ----
function visible() {
  let list;
  if (tab === "saved") list = Object.values(saved).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  else if (tab === "archive") list = releases.filter((r) => r.is_list_only && r.bandcamp);
  else list = releases.filter((r) => !r.is_list_only && r.genres.length && !skipped.has(r.key));
  if (chosen.size && tab !== "archive") list = list.filter((r) => r.genres.some((g) => chosen.has(g)));
  return list;
}

function renderChips() {
  const pool = releases.filter((r) => !r.is_list_only && !skipped.has(r.key));
  const counts = Object.fromEntries(GENRES.map((g) => [g, pool.filter((r) => r.genres.includes(g)).length]));
  $("#chips").innerHTML = `<button class="chip ${chosen.size ? "" : "on"}" data-g="">All</button>` +
    GENRES.filter((g) => counts[g] || chosen.has(g)).map((g) =>
      `<button class="chip ${chosen.has(g) ? "on" : ""}" data-g="${esc(g)}" aria-pressed="${chosen.has(g)}">${esc(g)}<span class="n">${counts[g]}</span></button>`).join("");
  $("#chips").hidden = tab === "archive";
}

// "LINKS" menu: every place you can open the album. Hidden entirely when there are none.
function linksMenu(r, label) {
  const links = [];
  if (r.bandcamp?.url) links.push(["Bandcamp", r.bandcamp.url]);
  if (r.spotify) links.push(["Spotify", r.spotify]);
  if (!links.length) return "";
  return `<details class="links">
    <summary aria-label="Links for ${esc(label)}">Links</summary>
    <div class="links-menu">${links.map(([name, url]) =>
      `<a href="${esc(url)}" target="_blank" rel="noopener">${name}<span aria-hidden="true">↗</span></a>`).join("")}</div>
  </details>`;
}

function card(r) {
  const img = art(r);
  const label = `${r.artist} — ${r.album}`;
  const hasLinks = !!(r.bandcamp?.url || r.spotify);
  const pic = img ? `<img loading="lazy" src="${img}" alt="">` : `<span class="none">no artwork</span>`;
  // no in-app playback: tapping the cover opens the album's LINKS menu
  const cover = hasLinks
    ? `<button class="cover" data-act="links" aria-label="Show links for ${esc(label)}">${pic}</button>`
    : `<div class="cover">${pic}</div>`;
  return `<article class="card ${heard.has(r.key) ? "heard" : ""}" data-key="${esc(r.key)}">
    ${cover}
    <div class="meta">
      <div class="titles">
        <div class="album" title="${esc(r.album)}">${esc(r.album)}</div>
        <div class="artist">${esc(r.artist)}</div>
        <div class="genre">${esc(r.genres.join(" · ") || "unsorted")}</div>
        ${linksMenu(r, label)}
      </div>
      <button class="mini ${saved[r.key] ? "on" : ""}" data-act="save" aria-label="${saved[r.key] ? "Unsave" : "Save"} ${esc(label)}" aria-pressed="${!!saved[r.key]}">${ICON.save}</button>
      ${tab === "new" ? `<button class="mini" data-act="skip" aria-label="Skip ${esc(label)}">${ICON.skip}</button>` : ""}
    </div>
  </article>`;
}

function render() {
  renderChips();
  const list = visible();
  $("#savedCount").textContent = Object.keys(saved).length || "";
  if (!list.length) {
    $("#feed").innerHTML = `<p class="empty">${tab === "saved" ? "Nothing saved yet." : "Nothing here for this filter."}</p>`;
    return;
  }
  // group by day on the New tab
  const groups = [];
  for (const r of list) {
    const label = tab === "new" ? dayLabel(r.date) : "";
    if (!groups.length || groups.at(-1).label !== label) groups.push({ label, items: [] });
    groups.at(-1).items.push(r);
  }
  $("#feed").innerHTML = groups.map((g) =>
    (g.label ? `<h2 class="day"><span>${esc(g.label)}</span><span>${g.items.length}</span></h2>` : "") +
    `<div class="grid">${g.items.map(card).join("")}</div>`).join("");
}

function toggleSave(r) {
  if (saved[r.key]) delete saved[r.key]; else saved[r.key] = r;
  store.set("saved", saved);
}

// ---- events ----
// only one LINKS menu open at a time; tapping elsewhere closes it
document.addEventListener("toggle", (e) => {
  if (e.target.matches?.("details.links") && e.target.open)
    document.querySelectorAll("details.links[open]").forEach((d) => d !== e.target && (d.open = false));
}, true);
document.addEventListener("click", (e) => {
  if (!e.target.closest("details.links, [data-act=links]"))
    document.querySelectorAll("details.links[open]").forEach((d) => (d.open = false));
});
$("#feed").addEventListener("click", (e) => {
  // opening any album link fades that album, so you can see what you've already checked out
  const out = e.target.closest(".links-menu a");
  if (out) { const k = out.closest(".card").dataset.key; heard.add(k); store.set("heard", [...heard].slice(-2000)); out.closest(".card").classList.add("heard"); return; }
  const btn = e.target.closest("[data-act]"); if (!btn) return;
  const key = btn.closest(".card").dataset.key;
  const r = releases.find((x) => x.key === key) || saved[key];
  const act = btn.dataset.act;
  if (act === "links") { const d = btn.closest(".card").querySelector("details.links"); if (d) d.open = !d.open; }
  if (act === "save") { toggleSave(r); render(); }
  if (act === "skip") { skipped.add(key); store.set("skipped", [...skipped].slice(-5000)); render(); }
});
$("#chips").addEventListener("click", (e) => {
  const c = e.target.closest(".chip"); if (!c) return;
  const g = c.dataset.g;
  if (!g) chosen.clear(); else chosen.has(g) ? chosen.delete(g) : chosen.add(g);
  store.set("genres", [...chosen]); render();
});
document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  tab = b.dataset.tab;
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
  render(); window.scrollTo(0, 0);
});

// ---- load ----
async function load() {
  const bust = `?t=${Date.now()}`;
  try {
    const [rel, status] = await Promise.all([
      fetch("data/releases.json" + bust).then((r) => r.json()),
      fetch("data/status.json" + bust).then((r) => r.json()).catch(() => null),
    ]);
    releases = rel; renderStatus(status); render();
  } catch {
    $("#status").className = "status stale";
    $("#status").textContent = "offline";
  }
}
load();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

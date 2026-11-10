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
let lastUpdated = "";
// "7:30am" today, "yesterday 11pm", or "Thu 9:15pm"
function when(iso) {
  const d = new Date(iso), now = new Date();
  const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(" ", "").replace(":00", "").toLowerCase();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  return days === 0 ? t : days === 1 ? `yesterday ${t}` : `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${t}`;
}
function renderStatus(status) {
  const el = $("#status");
  if (!status?.finished) { el.className = "status stale"; el.textContent = "no update data"; return; }
  const hours = (Date.now() - new Date(status.finished)) / 36e5;
  lastUpdated = when(status.finished);
  const warn = status.ok === false ? " · warn" : "";
  if (hours > STALE_HOURS) { el.className = "status stale"; el.textContent = `stale · last run ${ago(status.finished)}`; }
  else { el.className = "status"; el.textContent = `Updated ${lastUpdated} · ${status.new_in_feed ?? 0} new${warn}`; }
  el.title = `Last run ${new Date(status.finished).toLocaleString()}`;
}

// ---- filtering ----
let query = "";
// case- and accent-insensitive ("bjork" finds "Björk", "mid" finds "Mið")
const fold = (t) => String(t || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[ðÐ]/g, "d").toLowerCase();

function visible() {
  if (query) {
    // search everything in the app (feed incl. skipped, plus Saved), ignoring tabs and genre filters
    const q = fold(query).trim();
    const pool = releases.filter((r) => !r.is_list_only && r.genres.length);
    const keys = new Set(pool.map((r) => r.key));
    for (const r of Object.values(saved)) if (!keys.has(r.key)) pool.push(r);
    return pool.filter((r) => fold(`${r.artist} ${r.album}`).includes(q))
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  }
  let list;
  if (tab === "saved") list = Object.values(saved).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  else list = releases.filter((r) => !r.is_list_only && r.genres.length && !skipped.has(r.key));
  if (chosen.size) list = list.filter((r) => r.genres.some((g) => chosen.has(g)));
  return list;
}

function renderChips() {
  const pool = releases.filter((r) => !r.is_list_only && !skipped.has(r.key));
  const counts = Object.fromEntries(GENRES.map((g) => [g, pool.filter((r) => r.genres.includes(g)).length]));
  $("#chips").innerHTML = `<button class="chip ${chosen.size ? "" : "on"}" data-g="">All</button>` +
    GENRES.filter((g) => counts[g] || chosen.has(g)).map((g) =>
      `<button class="chip ${chosen.has(g) ? "on" : ""}" data-g="${esc(g)}" aria-pressed="${chosen.has(g)}">${esc(g)}</button>`).join("");
}

// "LINKS" menu: every place you can open the album. Hidden entirely when there are none.
function linksMenu(r, label) {
  const links = [];
  if (r.bandcamp?.url) links.push(["Bandcamp", r.bandcamp.url]);
  if (r.spotify) links.push(["Spotify", r.spotify]);
  if (r.apple) links.push(["Apple Music", r.apple]);
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
  const hasLinks = !!(r.bandcamp?.url || r.spotify || r.apple);
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
  $("#chips").hidden = !!query;
  $("#feed").classList.toggle("searching", !!query);
  if (!list.length) {
    $("#feed").innerHTML = `<p class="empty">${query ? `No artist or album matching “${esc(query)}”.` : tab === "saved" ? "Nothing saved yet." : "Nothing here for this filter."}</p>`;
    return;
  }
  // group by day on the New tab
  const groups = [];
  for (const r of list) {
    const label = query ? "" : tab === "new" ? dayLabel(r.date) : "";
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

// ---- search (icon top-right → expands into a text box; results update on every letter) ----
const qInput = $("#q"), qBox = $("#searchBox"), qOpen = $("#qOpen");
function openSearch() {
  qBox.hidden = false; qOpen.setAttribute("aria-expanded", "true");
  qInput.focus();
}
function closeSearch() {
  qInput.value = ""; qBox.hidden = true; qOpen.setAttribute("aria-expanded", "false");
  if (query) { query = ""; render(); }
  qOpen.focus({ preventScroll: true });
}
qOpen.addEventListener("click", openSearch);
$("#qClose").addEventListener("click", closeSearch);
qInput.addEventListener("input", () => { query = qInput.value; render(); window.scrollTo(0, 0); });
qInput.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSearch(); if (e.key === "Enter") qInput.blur(); });

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
let lastLoad = 0;
async function load() {
  const bust = `?t=${Date.now()}`;
  try {
    const [rel, status] = await Promise.all([
      fetch("data/releases.json" + bust, { cache: "no-store" }).then((r) => r.json()),
      fetch("data/status.json" + bust, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    ]);
    const before = new Set(releases.map((r) => r.key));
    releases = rel; renderStatus(status); render();
    lastLoad = Date.now();
    return before.size ? rel.filter((r) => !before.has(r.key) && !r.is_list_only && r.genres.length).length : 0;
  } catch {
    $("#status").className = "status stale";
    $("#status").textContent = "offline";
    return null;
  }
}
load();
let swReg = null;
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").then((r) => (swReg = r)).catch(() => {});

// ---- pull to refresh (like X / Instagram) ----
const ptr = $("#ptr");
const PULL_MAX = 110, PULL_TRIGGER = 70;
let startY = null, startX = 0, pull = 0, refreshing = false;

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
}
function setPull(px) {
  pull = px;
  ptr.style.transform = `translate(-50%, ${px - 44}px) rotate(${px * 3}deg)`;
  ptr.style.opacity = Math.min(1, px / PULL_TRIGGER);
  ptr.classList.toggle("ready", px >= PULL_TRIGGER);
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  ptr.classList.add("spinning");
  ptr.style.transition = "transform .2s"; setPull(56);
  swReg?.update().catch(() => {});          // also pick up a new version of the app itself
  const [added] = await Promise.all([load(), new Promise((r) => setTimeout(r, 600))]); // spinner shows ≥0.6s
  toast(added === null ? "Couldn't refresh — offline?" : added ? `${added} new release${added > 1 ? "s" : ""} · updated ${lastUpdated}` : `Up to date · updated ${lastUpdated}`);
  ptr.classList.remove("spinning", "ready"); setPull(0);
  setTimeout(() => (ptr.style.transition = ""), 250);
  refreshing = false;
}
document.addEventListener("touchstart", (e) => {
  startY = window.scrollY <= 0 && !refreshing && e.touches.length === 1 ? e.touches[0].clientY : null;
  startX = e.touches[0].clientX;
}, { passive: true });
document.addEventListener("touchmove", (e) => {
  if (startY === null) return;
  const dy = e.touches[0].clientY - startY;
  const dx = Math.abs(e.touches[0].clientX - startX);
  if (!pull && dx > dy) { startY = null; return; }     // sideways swipe (e.g. genre chips): not a pull
  if (dy <= 0 || window.scrollY > 0) { if (pull) setPull(0); return; }
  e.preventDefault();                                   // stop the page bouncing while we pull
  setPull(Math.min(PULL_MAX, dy * 0.5));                // resistance, like native apps
}, { passive: false });
document.addEventListener("touchend", () => {
  if (startY === null) return;
  startY = null;
  if (pull >= PULL_TRIGGER) refresh();
  else { ptr.style.transition = "transform .2s, opacity .2s"; setPull(0); setTimeout(() => (ptr.style.transition = ""), 250); }
});
// coming back to the app after a while also refreshes, so the feed is never stale when you open it
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - lastLoad > 10 * 60 * 1000) refresh();
});

"use strict";
// echo-yt frontend. Hash-routed views in #view; one always-present player in
// #watch, which CSS pins to the corner as a mini-player on every other page
// (moving a <video> in the DOM would stop it).

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("echo-yt." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("echo-yt." + k, JSON.stringify(v)); } catch {} },
};

// ---------- icons (lucide-style paths) ----------
const P = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  channels: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 4a4 4 0 0 1 0 8M19 15a7 7 0 0 1 3 6"/>',
  list: '<path d="M3 6h13M3 12h13M3 18h7"/><path d="m15 15 6 3.5-6 3.5z" fill="currentColor"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3.5 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  play: '<path d="M7 4.5v15a.6.6 0 0 0 .9.5l12-7.5a.6.6 0 0 0 0-1l-12-7.5a.6.6 0 0 0-.9.5z" fill="currentColor"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/>',
  next: '<path d="M5 5v14l11-7z" fill="currentColor"/><path d="M19 5v14"/>',
  prev: '<path d="M19 5v14L8 12z" fill="currentColor"/><path d="M5 5v14"/>',
  vol: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a9 9 0 0 1 0 12"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/><path d="m17 9 5 6M22 9l-5 6"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  expand: '<path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/>',
  shuffle: '<path d="M3 7h3c5 0 7 10 12 10h3M3 17h3c1.8 0 3.2-1.2 4.5-3M14 9c1-1.2 2.3-2 4-2h3"/><path d="m18 4 3 3-3 3M18 14l3 3-3 3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/>',
  refresh: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
};
const ic = (n, s = 18) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[n]}</svg>`;

// ---------- helpers ----------
async function api(path, opts = {}) {
  if (opts.json !== undefined) {
    opts = { ...opts, method: opts.method || "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.json) };
  }
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `Request failed (${r.status})`);
  return data;
}
function toast(msg, { bad = false, action, ms = 3500 } = {}) {
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.className = "ghost"; b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.append(b);
  }
  $("toasts").append(el);
  setTimeout(() => el.remove(), ms);
}
const fail = e => toast(e.message || String(e), { bad: true });
function clock(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
function compact(n) {
  if (n == null) return "";
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, "") + "K";
  return String(n);
}
function ago(ts) {
  if (!ts) return "";
  const s = Date.now() / 1000 - ts;
  for (const [u, n] of [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (s >= n) { const c = Math.floor(s / n); return `${c} ${u}${c > 1 ? "s" : ""} ago`; }
  }
  return "just now";
}
const thumbUrl = id => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const bigThumb = id => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const safeAttr = esc;

// every video the page has seen, so buttons can find its details by id
const known = new Map();
const remember = list => { list.forEach(v => known.set(v.id, { ...known.get(v.id), ...v })); return list; };

function thumbHtml(v) {
  const pct = v.position && v.duration ? Math.min(100, v.position / v.duration * 100) : 0;
  const badge = v.live ? '<span class="dur live">LIVE</span>' : v.duration ? `<span class="dur">${clock(v.duration)}</span>` : "";
  return `<a class="thumb" href="#/watch/${v.id}" data-play="${v.id}"><img loading="lazy" referrerpolicy="no-referrer" src="${thumbUrl(v.id)}" alt="">${badge}${pct > 1 ? `<span class="prog"><i style="width:${pct}%"></i></span>` : ""}</a>`;
}
const chanLink = v => v.channel ? (v.channel_id ? `<a class="vchan" href="#/channel/${esc(v.channel_id)}">${esc(v.channel)}</a>` : esc(v.channel)) : "";
function subLine(v, extra) {
  const bits = [v.view_count != null ? compact(v.view_count) + " views" : "", ago(v.timestamp), extra].filter(Boolean);
  return bits.join(" · ");
}
const addBtn = v => `<button class="ghost icon addbtn" data-add="${v.id}" title="Add to playlist">${ic("plus", 17)}</button>`;
const card = v => `<article class="card">${thumbHtml(v)}<div class="meta"><div>
  <a class="vtitle" href="#/watch/${v.id}" data-play="${v.id}" title="${esc(v.title)}">${esc(v.title)}</a>
  <div class="vsub">${chanLink(v)}</div><div class="vsub">${esc(subLine(v))}</div></div>${addBtn(v)}</div></article>`;
function videoGrid(list, label) {
  remember(list);
  return `<div class="grid" data-queue="${esc(label)}">${list.map(card).join("")}</div>`;
}
const skeleton = (n = 12) => `<div class="grid skel">${Array(n).fill('<div><div class="thumb"></div><div class="line"></div><div class="line"></div></div>').join("")}</div>`;
const emptyBox = (t, s) => `<div class="empty"><strong>${esc(t)}</strong>${esc(s)}</div>`;
const errBox = e => `<div class="err">${esc(e.message || e)}</div>`;

// ---------- modals ----------
function closeModal() { $("modal").hidden = true; $("modal").innerHTML = ""; }
$("modal").addEventListener("mousedown", e => { if (e.target === $("modal")) closeModal(); });
function openModal(html) { $("modal").innerHTML = `<div class="dialog">${html}</div>`; $("modal").hidden = false; return $("modal").firstChild; }

function askConfirm(title, text, label) {
  return new Promise(res => {
    const d = openModal(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="btns"><button id="mNo" class="ghost">Cancel</button><button id="mYes" class="danger">${esc(label)}</button></div>`);
    d.querySelector("#mNo").onclick = () => { closeModal(); res(false); };
    d.querySelector("#mYes").onclick = () => { closeModal(); res(true); };
  });
}
function askName(title, value, label) {
  return new Promise(res => {
    const d = openModal(`<h3>${esc(title)}</h3><form id="mF"><input id="mI" type="text" value="${esc(value)}" placeholder="Playlist name" maxlength="120"><button class="primary">${esc(label)}</button></form>`);
    const i = d.querySelector("#mI"); i.focus(); i.select();
    d.querySelector("#mF").onsubmit = e => { e.preventDefault(); const v = i.value.trim(); if (v) { closeModal(); res(v); } };
  });
}

async function addToPlaylist(video) {
  try {
    const [lists, holding] = await Promise.all([api("/api/playlists"), api(`/api/video/${video.id}/playlists`)]);
    const d = openModal(`<h3>Save to playlist</h3><div id="plOpts">${lists.map(p => `<label class="pl-opt"><input type="checkbox" data-pl="${p.id}" ${holding.includes(p.id) ? "checked" : ""}><span>${esc(p.name)}</span></label>`).join("") || '<p>No playlists yet. Name your first one.</p>'}</div>
      <form id="plNew"><input type="text" id="plName" placeholder="New playlist…" maxlength="120"><button class="primary">Create</button></form>
      <div class="btns"><button id="plDone" class="ghost">Done</button></div>`);
    d.querySelector("#plDone").onclick = closeModal;
    d.querySelector("#plOpts").onchange = async e => {
      const pid = e.target.dataset.pl;
      try {
        if (e.target.checked) await api(`/api/playlists/${pid}/items`, { json: video });
        else await api(`/api/playlists/${pid}/items/${video.id}`, { method: "DELETE" });
        refreshRail();
      } catch (err) { fail(err); }
    };
    d.querySelector("#plNew").onsubmit = async e => {
      e.preventDefault();
      const name = d.querySelector("#plName").value.trim();
      if (!name) return;
      try {
        const p = await api("/api/playlists", { json: { name } });
        await api(`/api/playlists/${p.id}/items`, { json: video });
        closeModal(); refreshRail(); toast(`Saved to ${name}`);
      } catch (err) { fail(err); }
    };
  } catch (e) { fail(e); }
}

function applyLook() {
  const root = document.documentElement;
  root.dataset.theme = store.get("theme", "dark");
  root.style.setProperty("--ui-scale", store.get("scale", 1));
}
async function openSettings() {
  const st = await api("/api/status").catch(() => ({}));
  const tool = (name, ok) => `${name} <b class="${ok ? "ok" : "no"}">${ok ? "found" : "missing"}</b>`;
  const d = openModal(`<h3>Settings</h3>
    <div class="setting"><span>Theme</span><select id="sTheme"><option value="dark">Dark</option><option value="light">Light</option></select></div>
    <div class="setting"><span>Text size</span><select id="sScale">${[[0.9, "Small"], [1, "Normal"], [1.12, "Large"], [1.25, "Extra large"]].map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>
    <div class="setting"><span>Preferred quality</span><select id="sQual">${[360, 480, 720, 1080, 1440, 2160].map(q => `<option value="${q}">${q}p</option>`).join("")}</select></div>
    <div class="tools">${tool("yt-dlp", st.ytdlp)} · ${tool("ffmpeg", st.ffmpeg)} · ${tool("JS runtime", st.js_runtime)} · ${tool("PoToken provider", st.pot_provider)}<div id="sYtdlp">Checking yt-dlp version…</div></div>
    <div class="btns"><button id="sDone" class="ghost">Done</button></div>`);
  const t = d.querySelector("#sTheme"), s = d.querySelector("#sScale"), q = d.querySelector("#sQual");
  t.value = store.get("theme", "dark"); s.value = store.get("scale", 1); q.value = store.get("quality", 1080);
  t.onchange = () => { store.set("theme", t.value); applyLook(); };
  s.onchange = () => { store.set("scale", +s.value); applyLook(); };
  q.onchange = () => store.set("quality", +q.value);
  d.querySelector("#sDone").onclick = closeModal;
  const box = d.querySelector("#sYtdlp");
  api("/api/ytdlp").then(v => {
    if (!v.installed) { box.textContent = "Couldn't read the yt-dlp version."; return; }
    const cmd = '<code>sudo pacman -Syu</code>';
    if (v.update) box.innerHTML = `yt-dlp ${esc(v.installed)}. <b class="no">Update available: ${esc(v.available)}</b><br>Update with ${cmd}`;
    else if (v.stale) box.innerHTML = `yt-dlp ${esc(v.installed)}. <b class="no">This version is over 60 days old</b><br>Check for an update with ${cmd}`;
    else box.innerHTML = `yt-dlp ${esc(v.installed)}. <b class="ok">${v.available ? "Latest pacman knows about" : "Recent version"}</b>`;
  }).catch(() => { box.textContent = "Couldn't check the yt-dlp version."; });
}

// ---------- rail ----------
const NAV = [["#/", "home", "Home"], ["#/channels", "channels", "Channels"], ["#/playlists", "list", "Playlists"], ["#/history", "history", "History"]];
$("nav").innerHTML = NAV.map(([h, i, t]) => `<a href="${h}" data-nav="${h}">${ic(i)}${t}</a>`).join("");
$("railNewPl").innerHTML = ic("plus", 15);
$("settingsBtn").innerHTML = ic("gear") + "Settings";
$("backBtn").innerHTML = ic("back");
$("searchIcon").innerHTML = ic("search");
let savedChannels = new Set();

async function refreshRail() {
  try {
    const [lists, chans] = await Promise.all([api("/api/playlists"), api("/api/channels")]);
    savedChannels = new Set(chans.map(c => c.id));
    $("railPlaylists").innerHTML = lists.map(p => `<a class="rail-item" href="#/playlist/${p.id}">${ic("list", 16)}<span>${esc(p.name)}</span></a>`).join("") || '<div class="rail-empty">None yet</div>';
    $("railChannels").innerHTML = chans.map(c => `<a class="rail-item" href="#/channel/${esc(c.id)}"><img src="${safeAttr(c.avatar || "")}" referrerpolicy="no-referrer" alt=""><span>${esc(c.name)}</span></a>`).join("") || '<div class="rail-empty">None yet</div>';
    markActive();
  } catch {}
}
function markActive() {
  const h = location.hash || "#/";
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("active", a.dataset.nav === h));
  document.querySelectorAll(".rail-item").forEach(a => a.classList.toggle("active", a.getAttribute("href") === h));
}
async function newPlaylist() {
  const name = await askName("New playlist", "", "Create");
  try {
    const p = await api("/api/playlists", { json: { name } });
    refreshRail();
    location.hash = `#/playlist/${p.id}`;
  } catch (e) { fail(e); }
}
$("railNewPl").onclick = newPlaylist;
$("settingsBtn").onclick = openSettings;
$("backBtn").onclick = () => history.back();

// ---------- search box ----------
const input = $("searchInput"), suggest = $("suggest");
let recent = [], sugIdx = -1;
function drawSuggest() {
  const typed = input.value.trim().toLowerCase();
  const items = recent.filter(q => !typed || (q.toLowerCase().includes(typed) && q.toLowerCase() !== typed)).slice(0, 8);
  sugIdx = -1;
  suggest.hidden = !items.length;
  suggest.innerHTML = items.map(q => `<div class="sug" data-q="${esc(q)}">${ic("history", 15)}<span>${esc(q)}</span><button type="button" class="ghost icon" data-forget="${esc(q)}" title="Remove">${ic("x", 13)}</button></div>`).join("");
}
input.addEventListener("focus", async () => { recent = await api("/api/searches").catch(() => []); drawSuggest(); });
input.addEventListener("input", drawSuggest);
input.addEventListener("blur", () => setTimeout(() => { suggest.hidden = true; }, 150));
input.addEventListener("keydown", e => {
  const rows = [...suggest.querySelectorAll(".sug")];
  if (e.key === "Escape") { suggest.hidden = true; input.blur(); return; }
  if (suggest.hidden || !rows.length || !["ArrowDown", "ArrowUp"].includes(e.key)) return;
  e.preventDefault();
  sugIdx = (sugIdx + (e.key === "ArrowDown" ? 1 : rows.length) + (sugIdx < 0 && e.key === "ArrowUp" ? 1 : 0)) % rows.length;
  rows.forEach((r, i) => r.classList.toggle("sel", i === sugIdx));
  input.value = rows[sugIdx].dataset.q;
});
suggest.addEventListener("mousedown", async e => {
  e.preventDefault();
  const forget = e.target.closest("[data-forget]");
  if (forget) {
    const q = forget.dataset.forget;
    recent = recent.filter(x => x !== q);
    drawSuggest();
    api("/api/searches?q=" + encodeURIComponent(q), { method: "DELETE" }).catch(fail);
    return;
  }
  const row = e.target.closest(".sug");
  if (row) { input.value = row.dataset.q; runSearch(); }
});
$("searchForm").addEventListener("submit", e => { e.preventDefault(); runSearch(); });
function runSearch() {
  const q = input.value.trim();
  if (!q) return;
  suggest.hidden = true; input.blur();
  const target = "#/search/" + encodeURIComponent(q);
  if (location.hash === target) { lastHash = null; route(); } else location.hash = target;
}

// ---------- views ----------
const view = $("view");
let lastHash = null, viewToken = 0, viewScroll = 0;

function loadMoreButton(container, fn) {
  const wrap = document.createElement("div");
  wrap.className = "more";
  wrap.innerHTML = '<button>Load more</button>';
  wrap.firstChild.onclick = async () => { wrap.firstChild.disabled = true; wrap.firstChild.textContent = "Loading…"; await fn(wrap); };
  container.append(wrap);
}
function appendCards(grid, list) { remember(list); grid.insertAdjacentHTML("beforeend", list.map(card).join("")); }

async function viewHome(token) {
  view.innerHTML = '<div id="hCont"></div><div id="hFeed"></div><div id="hRecent"></div>';
  const [hist, recents] = await Promise.all([api("/api/history?limit=40").catch(() => ({ videos: [] })), api("/api/searches").catch(() => [])]);
  if (token !== viewToken) return;
  const going = hist.videos.filter(v => v.position > 15 && v.duration && v.position < v.duration - 20).slice(0, 8);
  $("hCont").innerHTML = going.length ? `<h3 class="sec">Continue watching</h3>${videoGrid(going, "Continue watching")}` : "";
  $("hRecent").innerHTML = recents.length ? `<h3 class="sec">Recent searches</h3><div class="chips">${recents.map(q => `<a class="chip" href="#/search/${encodeURIComponent(q)}">${esc(q)}</a>`).join("")}</div>` : "";
  if (!savedChannels.size) {
    if (!going.length && !recents.length) $("hFeed").innerHTML = emptyBox("Search for something to watch", "Your saved channels, playlists and history will fill this page.");
    return;
  }
  $("hFeed").innerHTML = `<h3 class="sec">Latest from your channels</h3>${skeleton(8)}`;
  try {
    const f = await api("/api/feed");
    if (token !== viewToken) return;
    $("hFeed").innerHTML = `<h3 class="sec">Latest from your channels</h3>${videoGrid(f.videos.slice(0, 16), "Latest from your channels")}`;
  } catch (e) { if (token === viewToken) $("hFeed").innerHTML = errBox(e); }
}

async function viewSearch(token, q) {
  input.value = q;
  view.innerHTML = skeleton();
  try {
    const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (token !== viewToken) return;
    if (r.kind === "video") { location.replace(`#/watch/${r.id}`); return; }
    if (r.kind === "channel") { location.replace(`#/channel/${r.id}`); return; }
    if (!r.videos.length) { view.innerHTML = emptyBox("No results", `Nothing came back for “${q}”.`); return; }
    view.innerHTML = videoGrid(r.videos, `Results for “${q}”`);
    const grid = view.firstChild;
    const pager = (start) => loadMoreButton(view, async wrap => {
      try {
        const more = await api(`/api/search?q=${encodeURIComponent(q)}&start=${start}`);
        wrap.remove();
        appendCards(grid, more.videos);
        if (more.more) pager(start + 24);
      } catch (e) { wrap.remove(); fail(e); }
    });
    if (r.more) pager(25);
  } catch (e) { if (token === viewToken) view.innerHTML = errBox(e); }
}

async function viewChannels(token) {
  view.innerHTML = '<h2 class="title">Channels</h2><div id="cList"></div><div id="cFeed"></div>';
  const chans = await api("/api/channels");
  if (token !== viewToken) return;
  if (!chans.length) { $("cList").innerHTML = emptyBox("No saved channels", "Open a channel from any video and press Save channel, or paste a channel link into the search box."); return; }
  $("cList").innerHTML = `<div class="chan-tiles">${chans.map(c => `<a class="tile" href="#/channel/${esc(c.id)}"><img src="${safeAttr(c.avatar || "")}" referrerpolicy="no-referrer" alt=""><b>${esc(c.name)}</b><small>${c.followers ? compact(c.followers) + " subscribers" : ""}</small></a>`).join("")}</div>`;
  const load = async refresh => {
    $("cFeed").innerHTML = `<h3 class="sec">Latest uploads</h3>${skeleton(8)}`;
    try {
      const f = await api("/api/feed" + (refresh ? "?refresh=true" : ""));
      if (token !== viewToken) return;
      $("cFeed").innerHTML = `<h3 class="sec">Latest uploads<span class="grow"></span><button id="feedRefresh" class="ghost">${ic("refresh", 15)}Refresh</button></h3>${videoGrid(f.videos, "Latest uploads")}`;
      if (f.failed.length) toast(`Couldn't load the latest uploads from ${f.failed.join(", ")}`, { bad: true, ms: 8000 });
      $("feedRefresh").onclick = () => load(true);
    } catch (e) { if (token === viewToken) $("cFeed").innerHTML = errBox(e); }
  };
  load(false);
}

async function viewChannel(token, id) {
  view.innerHTML = skeleton();
  try {
    const r = await api(`/api/channel/${encodeURIComponent(id)}`);
    if (token !== viewToken) return;
    const c = r.channel;
    view.innerHTML = `<div class="head">${c.avatar ? `<div class="bg" style="background-image:url('${safeAttr(c.avatar)}')"></div><img class="avatar" src="${safeAttr(c.avatar)}" referrerpolicy="no-referrer" alt="">` : ""}
      <div class="info"><h2>${esc(c.name)}</h2><div class="sub">${c.followers ? compact(c.followers) + " subscribers" : ""}</div>
      <div class="acts"><button id="chSave"></button></div></div></div>${videoGrid(r.videos, c.name)}`;
    const grid = view.querySelector(".grid");
    channelButton($("chSave"), id, c.saved, c.name);
    const pager = start => loadMoreButton(view, async wrap => {
      try {
        const more = await api(`/api/channel/${encodeURIComponent(id)}?start=${start}`);
        wrap.remove();
        appendCards(grid, more.videos);
        if (more.more) pager(start + 30);
      } catch (e) { wrap.remove(); fail(e); }
    });
    if (r.more) pager(31);
  } catch (e) { if (token === viewToken) view.innerHTML = errBox(e); }
}
function channelButton(btn, id, saved, name) {
  const draw = () => { btn.className = saved ? "on" : "primary"; btn.textContent = saved ? "Saved" : "Save channel"; };
  draw();
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api(`/api/channels/${encodeURIComponent(id)}`, { method: saved ? "DELETE" : "POST" });
      saved = !saved;
      draw();
      toast(saved ? `Saved ${name}` : `Removed ${name}`);
      refreshRail();
    } catch (e) { fail(e); }
    btn.disabled = false;
  };
}

async function viewPlaylists(token) {
  view.innerHTML = `<h2 class="title" style="display:flex;align-items:center;gap:12px">Playlists<span class="grow"></span><button id="plNewBtn" class="primary">${ic("plus", 16)}New playlist</button></h2><div id="plGrid"></div>`;
  $("plNewBtn").onclick = newPlaylist;
  const lists = await api("/api/playlists");
  if (token !== viewToken) return;
  if (!lists.length) { $("plGrid").innerHTML = emptyBox("No playlists yet", "Hover any video and press + to start one."); return; }
  $("plGrid").innerHTML = `<div class="grid">${lists.map(p => `<article class="card"><div class="stack"><a class="thumb" href="#/playlist/${p.id}">${p.cover ? `<img loading="lazy" referrerpolicy="no-referrer" src="${thumbUrl(p.cover)}" alt="">` : `<div class="nocover">${ic("list", 28)}</div>`}<span class="dur">${p.count} video${p.count === 1 ? "" : "s"}</span></a></div>
    <div class="meta"><div><a class="vtitle" href="#/playlist/${p.id}">${esc(p.name)}</a><div class="vsub">${p.seconds ? clock(p.seconds) : "Empty"}</div></div></div></article>`).join("")}</div>`;
}

function rowHtml(v, { num, extra, remove } = {}) {
  return `<div class="row" data-id="${v.id}" ${num ? 'draggable="true"' : ""}>${num ? `<span class="num">${num}</span>` : ""}${thumbHtml(v)}
    <div class="body"><a class="vtitle" href="#/watch/${v.id}" data-play="${v.id}">${esc(v.title)}</a><div class="vsub">${chanLink(v)}${extra ? " · " + esc(extra) : ""}</div></div>
    ${addBtn(v)}${remove ? `<button class="ghost icon" data-remove="${v.id}" title="${esc(remove)}">${ic("x", 16)}</button>` : ""}</div>`;
}

async function viewPlaylist(token, pid) {
  view.innerHTML = skeleton(6);
  try {
    const p = await api(`/api/playlists/${pid}`);
    if (token !== viewToken) return;
    remember(p.videos);
    const total = p.videos.reduce((s, v) => s + (v.duration || 0), 0);
    const cover = p.videos[0] && bigThumb(p.videos[0].id);
    view.innerHTML = `<div class="head">${cover ? `<div class="bg" style="background-image:url('${cover}')"></div><img class="cover" src="${cover}" referrerpolicy="no-referrer" alt="">` : ""}
      <div class="info"><h2>${esc(p.name)}</h2><div class="sub">${p.videos.length} video${p.videos.length === 1 ? "" : "s"}${total ? " · " + clock(total) : ""}</div>
      <div class="acts"><button id="plPlay" class="primary">${ic("play", 15)}Play all</button><button id="plShuf">${ic("shuffle", 15)}Shuffle</button><button id="plRen" class="ghost">${ic("edit", 15)}Rename</button><button id="plDel" class="ghost">${ic("trash", 15)}Delete</button></div></div></div>
      ${p.videos.length ? `<div class="rows" data-queue="${esc(p.name)}" data-advance="1" id="plRows">${p.videos.map((v, i) => rowHtml(v, { num: i + 1, remove: "Remove from playlist" })).join("")}</div>` : emptyBox("This playlist is empty", "Hover any video and press + to add it here.")}`;
    const startWith = list => { if (!list.length) return; setQueue(list, p.name, true); location.hash = `#/watch/${list[0].id}`; };
    $("plPlay").onclick = () => startWith(p.videos);
    $("plShuf").onclick = () => {
      const a = [...p.videos];
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      startWith(a);
    };
    $("plRen").onclick = async () => {
      const name = await askName("Rename playlist", p.name, "Rename");
      try { await api(`/api/playlists/${pid}`, { method: "PATCH", json: { name } }); refreshRail(); rerender(); } catch (e) { fail(e); }
    };
    $("plDel").onclick = async () => {
      if (!await askConfirm("Delete playlist?", `“${p.name}” will be deleted. The videos themselves stay on YouTube.`, "Delete")) return;
      try { await api(`/api/playlists/${pid}`, { method: "DELETE" }); refreshRail(); location.hash = "#/playlists"; } catch (e) { fail(e); }
    };
    const rows = $("plRows");
    if (!rows) return;
    rows.addEventListener("click", async e => {
      const b = e.target.closest("[data-remove]");
      if (!b) return;
      try { await api(`/api/playlists/${pid}/items/${b.dataset.remove}`, { method: "DELETE" }); refreshRail(); rerender(); } catch (err) { fail(err); }
    });
    let drag = null;
    rows.addEventListener("dragstart", e => { drag = e.target.closest(".row"); if (drag) { drag.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; } });
    rows.addEventListener("dragover", e => {
      const over = e.target.closest(".row");
      if (!drag || !over) return;
      e.preventDefault();
      rows.querySelectorAll(".over").forEach(r => r.classList.remove("over"));
      if (over !== drag) over.classList.add("over");
    });
    rows.addEventListener("drop", async e => {
      const over = e.target.closest(".row");
      if (!drag || !over || over === drag) return;
      e.preventDefault();
      over.before(drag);
      rows.querySelectorAll(".num").forEach((n, i) => n.textContent = i + 1);
      try { await api(`/api/playlists/${pid}/order`, { method: "PUT", json: { ids: [...rows.children].map(r => r.dataset.id) } }); } catch (err) { fail(err); }
    });
    rows.addEventListener("dragend", () => { rows.querySelectorAll(".over,.dragging").forEach(r => r.classList.remove("over", "dragging")); drag = null; });
  } catch (e) { if (token === viewToken) view.innerHTML = errBox(e); }
}

function dayLabel(ts) {
  const d = new Date(ts * 1000), now = new Date();
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

async function viewHistory(token, tab) {
  tab = tab === "searches" ? "searches" : "watched";
  view.innerHTML = `<h2 class="title" style="display:flex;align-items:center;gap:12px">History<span class="grow"></span>
    <button id="hClear" class="ghost">${ic("trash", 15)}Clear all</button></h2>
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:8px"><div class="seg"><button data-t="watched" class="${tab === "watched" ? "active" : ""}">Watched</button><button data-t="searches" class="${tab === "searches" ? "active" : ""}">Searches</button></div>
    ${tab === "watched" ? '<input id="hFilter" type="text" placeholder="Filter by title or channel…" style="max-width:320px">' : ""}</div><div id="hList"></div>`;
  view.querySelectorAll(".seg button").forEach(b => b.onclick = () => { location.hash = b.dataset.t === "searches" ? "#/history/searches" : "#/history"; });

  $("hClear").onclick = async () => {
    const what = tab === "watched" ? "watch history" : "search history";
    if (!await askConfirm(`Clear ${what}?`, "This can't be undone. Playlists and channels aren't affected.", "Clear")) return;
    try { await api(tab === "watched" ? "/api/history" : "/api/searches", { method: "DELETE" }); rerender(); } catch (e) { fail(e); }
  };

  if (tab === "searches") {
    const qs = await api("/api/searches");
    if (token !== viewToken) return;
    $("hList").innerHTML = qs.length ? `<div class="chips" style="margin-top:14px">${qs.map(q => `<a class="chip" href="#/search/${encodeURIComponent(q)}">${esc(q)}</a>`).join("")}</div>` : emptyBox("No searches yet", "What you search for shows up here.");
    return;
  }

  const list = $("hList");
  let offset = 0, q = "", lastDay = null;
  const page = async fresh => {
    try {
      const r = await api(`/api/history?limit=60&offset=${offset}&q=${encodeURIComponent(q)}`);
      if (token !== viewToken) return;
      remember(r.videos);
      if (fresh) { list.innerHTML = ""; lastDay = null; list.dataset.queue = "History"; }
      if (fresh && !r.videos.length) { list.innerHTML = q ? emptyBox("No matches", "Nothing in your history matches that.") : emptyBox("Nothing watched yet", "Videos you play show up here."); return; }
      let html = "";
      for (const v of r.videos) {
        const d = dayLabel(v.watched_at);
        if (d !== lastDay) { html += `<div class="day">${esc(d)}</div>`; lastDay = d; }
        html += rowHtml(v, { extra: new Date(v.watched_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), remove: "Remove from history" });
      }
      list.insertAdjacentHTML("beforeend", html);
      offset += r.videos.length;
      if (r.more) loadMoreButton(list, async wrap => { wrap.remove(); await page(false); });
    } catch (e) { if (token === viewToken) list.innerHTML = errBox(e); }
  };
  list.addEventListener("click", async e => {
    const b = e.target.closest("[data-remove]");
    if (!b) return;
    try {
      await api(`/api/history/${b.dataset.remove}`, { method: "DELETE" });
      b.closest(".row").remove();
      offset = Math.max(0, offset - 1);
    } catch (err) { fail(err); }
  });
  let t;
  $("hFilter").oninput = e => { clearTimeout(t); t = setTimeout(() => { q = e.target.value; offset = 0; page(true); }, 200); };
  page(true);
}

function rerender() { lastHash = null; route(); }

// A click on any video remembers the list it came from, as "up next".
document.addEventListener("click", e => {
  const add = e.target.closest("[data-add]");
  if (add) { e.preventDefault(); const v = known.get(add.dataset.add); if (v) addToPlaylist(v); return; }
  const play = e.target.closest("[data-play]");
  if (!play) return;
  const box = play.closest("[data-queue]");
  if (box && !box.closest("#queue")) {
    const ids = [...new Set([...box.querySelectorAll("[data-play]")].map(a => a.dataset.play))];
    setQueue(ids.map(i => known.get(i)).filter(Boolean), box.dataset.queue, box.dataset.advance === "1");
  } else if (!box) {
    setQueue([], "", false);
  }
});

// ---------- router ----------
function route() {
  const hash = location.hash || "#/";
  const [, name = "", raw = ""] = hash.split("/");
  const arg = decodeURIComponent(raw);
  const watching = name === "watch";
  markActive();
  if (!watching && name !== "search") input.value = "";

  if (watching) {
    if (view.hidden === false) viewScroll = view.scrollTop;
    view.hidden = true;
    $("watch").hidden = false;
    document.body.classList.remove("mini");
    if (!current || current.id !== arg) loadVideo(arg);
    return;
  }

  view.hidden = false;
  document.body.classList.toggle("mini", !!current);
  $("watch").hidden = !current;
  if (hash === lastHash) { view.scrollTop = viewScroll; return; }
  lastHash = hash;
  viewScroll = 0;
  view.scrollTop = 0;
  const token = ++viewToken;
  const guard = p => Promise.resolve(p).catch(e => { if (token === viewToken) view.innerHTML = errBox(e); });
  if (name === "search") guard(viewSearch(token, arg));
  else if (name === "channels") guard(viewChannels(token));
  else if (name === "channel") guard(viewChannel(token, arg));
  else if (name === "playlists") guard(viewPlaylists(token));
  else if (name === "playlist") guard(viewPlaylist(token, arg));
  else if (name === "history") guard(viewHistory(token, arg));
  else guard(viewHome(token));
}
window.addEventListener("hashchange", route);

// ---------- player ----------
const V = $("V"), A = $("A"), player = $("player");
let current = null, sources = null, loadToken = 0, retried = false, recorded = false, audioStall = false, pendingSeek = null;
let queue = { items: [], label: "", advance: false };
const split = () => sources?.mode === "split";
const isLive = () => sources?.mode === "live";

$("prevBtn").innerHTML = ic("prev", 20); $("nextBtn").innerHTML = ic("next", 20); $("fsBtn").innerHTML = ic("full", 19);
$("miniOpen").innerHTML = ic("expand", 15); $("miniClose").innerHTML = ic("x", 15);
$("rateSel").innerHTML = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(r => `<option value="${r}">${r}×</option>`).join("");
$("rateSel").value = store.get("rate", 1);
$("vol").value = store.get("volume", 0.9);

function setQueue(items, label, advance) { queue = { items: [...items], label, advance }; }
const queueIndex = () => queue.items.findIndex(v => v.id === current?.id);
function step(delta) {
  const i = queueIndex();
  const next = i >= 0 ? queue.items[i + delta] : null;
  if (next) location.hash = `#/watch/${next.id}`;
}

function clearMedia() {
  V.pause(); A.pause();
  V.removeAttribute("src"); A.removeAttribute("src");
  V.load(); A.load();
  audioStall = false;
}
function showError(msg) {
  player.classList.remove("busy");
  $("perr").hidden = false;
  $("perr").innerHTML = `<div>${esc(msg)}</div><button id="perrRetry">Try again</button>`;
  $("perrRetry").onclick = () => { const id = current.id; retried = false; current = null; loadVideo(id, true); };
}

async function loadVideo(id, refresh = false) {
  const token = ++loadToken;
  savePosition();
  clearMedia();
  const preview = known.get(id) || { id, title: "" };
  current = { ...preview, id };
  sources = null; retried = refresh; recorded = false;
  $("watch").scrollTop = 0;
  $("perr").hidden = true;
  player.classList.add("busy");
  $("poster").hidden = false;
  $("poster").src = bigThumb(id);
  $("haloImg").src = thumbUrl(id);
  drawInfo(null);
  drawQueue();
  try {
    const d = await api(`/api/video/${id}?quality=${store.get("quality", 1080)}${refresh ? "&refresh=true" : ""}`);
    if (token !== loadToken) return;
    current = d;
    known.set(id, { ...known.get(id), ...d, sources: undefined });
    drawInfo(d);
    drawQuality(d.sources);
    if (!queue.items.some(v => v.id === id)) moreFromChannel(d, token);
    drawQueue();
    let start = 0;
    if (!d.live && d.position > 15 && d.duration && d.position < d.duration - 20) {
      start = d.position;
      toast(`Resumed at ${clock(start)}`, { action: { label: "Start over", run: () => seekTo(0) }, ms: 6000 });
    }
    applySources(d.sources, start, true);
    mediaSession(d);
  } catch (e) {
    if (token === loadToken) showError(e.message);
  }
}

async function moreFromChannel(d, token) {
  if (!d.channel_id) return setQueue([], "", false);
  setQueue([], "", false);
  try {
    const r = await api(`/api/channel/${d.channel_id}/latest`);
    if (token !== loadToken) return;
    setQueue(remember(r.videos.filter(v => v.id !== d.id)), `More from ${d.channel}`, false);
    drawQueue();
  } catch {}
}

function applySources(s, at, autoplay) {
  sources = s;
  clearMedia();
  player.classList.add("busy");
  $("perr").hidden = true;
  pendingSeek = { at, autoplay };
  $("liveTag").hidden = !isLive();
  $("seek").style.visibility = isLive() ? "hidden" : "";
  applyVolume();
  if (split()) { V.src = s.video; A.src = s.audio; }
  else V.src = s.src;
  V.playbackRate = +$("rateSel").value;
  A.playbackRate = V.playbackRate;
}

V.addEventListener("loadedmetadata", () => {
  if (!pendingSeek) return;
  const { at, autoplay } = pendingSeek;
  pendingSeek = null;
  if (at) { V.currentTime = at; if (split()) A.currentTime = at; }
  if (autoplay) startPlayback();
});
function startPlayback() {
  V.play().catch(() => {});
}
V.addEventListener("play", () => {
  if (split()) A.play().catch(err => { if (err.name === "NotAllowedError") V.pause(); });
  drawPlay();
});
V.addEventListener("pause", () => { if (split() && !audioStall) A.pause(); drawPlay(); savePosition(); });
V.addEventListener("seeking", () => { if (split()) A.currentTime = V.currentTime; player.classList.add("busy"); });
V.addEventListener("seeked", () => player.classList.remove("busy"));
V.addEventListener("waiting", () => { player.classList.add("busy"); if (split()) A.pause(); });
V.addEventListener("playing", () => {
  player.classList.remove("busy");
  $("poster").hidden = true;
  if (split() && !audioStall) {
    // only seek the audio if it's really off: every seek makes it rebuffer
    if (Math.abs(A.currentTime - V.currentTime) > 0.3) A.currentTime = V.currentTime;
    A.play().catch(() => {});
  }
  if (!recorded && current) {
    recorded = true;
    const { id, title, channel, channel_id, duration, view_count, timestamp, live } = current;
    api("/api/history", { json: { id, title, channel, channel_id, duration, view_count, timestamp, live } }).catch(() => {});
  }
  drawPlay();
});
A.addEventListener("waiting", () => { if (split() && !V.paused) { audioStall = true; V.pause(); player.classList.add("busy"); } });
A.addEventListener("canplay", () => { if (audioStall) { audioStall = false; V.play().catch(() => {}); } });
V.addEventListener("ended", () => {
  A.pause();
  savePosition(current?.duration);
  const auto = queue.advance || store.get("autoplay", false);
  if (auto) step(1);
});

function mediaFailed() {
  if (!current || !sources) return;
  const at = V.currentTime || 0;
  if (!retried) { // stream addresses expire; ask yt-dlp for fresh ones once
    retried = true;
    api(`/api/video/${current.id}?quality=${store.get("quality", 1080)}&refresh=true`)
      .then(d => applySources(d.sources, at, true))
      .catch(e => showError(e.message));
  } else if (sources.fallback) { // browser can't decode this pair: try the single-file version
    applySources({ ...sources.fallback, heights: sources.heights }, at, true);
  } else {
    showError("This video couldn't be played in this browser.");
  }
}
V.addEventListener("error", () => { if (V.getAttribute("src")) mediaFailed(); });
A.addEventListener("error", () => { if (A.getAttribute("src")) mediaFailed(); });

// keep the separate audio element on the video's clock
setInterval(() => {
  if (split() && !V.paused && !V.seeking && A.readyState >= 2 && !audioStall) {
    const drift = A.currentTime - V.currentTime, rate = V.playbackRate;
    if (Math.abs(drift) > 0.3) { A.currentTime = V.currentTime; A.playbackRate = rate; }
    else A.playbackRate = rate * (1 - Math.max(-0.1, Math.min(0.1, drift)) * 0.5);
  }
}, 400);

function savePosition(at) {
  if (!current || !recorded || isLive()) return;
  const position = at ?? V.currentTime;
  if (!position) return;
  const body = new Blob([JSON.stringify({ position })], { type: "application/json" });
  navigator.sendBeacon(`/api/history/${current.id}/position`, body);
}
setInterval(() => { if (!V.paused) savePosition(); }, 10000);
window.addEventListener("pagehide", () => savePosition());

const totalTime = () => current?.duration || (isFinite(V.duration) ? V.duration : 0);
function seekTo(t) { if (isLive()) return; V.currentTime = Math.max(0, Math.min(t, totalTime() || t)); }
function togglePlay() { if (!sources) return; V.paused && !audioStall ? V.play().catch(() => {}) : (audioStall = false, V.pause()); }
function applyVolume() {
  const vol = +$("vol").value, muted = store.get("muted", false);
  V.muted = split() || muted; V.volume = split() ? 1 : vol;
  A.muted = muted; A.volume = vol;
  $("muteBtn").innerHTML = ic(muted || !vol ? "mute" : "vol", 20);
}
function drawPlay() { $("playBtn").innerHTML = ic(V.paused && !audioStall ? "play" : "pause", 21); }
function drawTime() {
  const d = totalTime();
  $("time").textContent = isLive() ? "" : `${clock(V.currentTime)} / ${clock(d)}`;
  $("seekFill").style.width = d ? `${V.currentTime / d * 100}%` : 0;
  let edge = 0;
  for (let i = 0; i < V.buffered.length; i++) {
    if (V.buffered.start(i) <= V.currentTime + 1) edge = Math.max(edge, V.buffered.end(i));
  }
  $("seekBuf").style.width = d ? `${edge / d * 100}%` : 0;
}
V.addEventListener("timeupdate", drawTime);
V.addEventListener("progress", drawTime);
drawPlay();

// seek bar
const seek = $("seek");
const seekFrac = e => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
let seeking = false;
seek.addEventListener("pointerdown", e => { seeking = true; seek.setPointerCapture(e.pointerId); seekTo(seekFrac(e) * totalTime()); });
seek.addEventListener("pointermove", e => {
  const f = seekFrac(e), tip = $("seekTip"), t = f * totalTime();
  const chapter = (current?.chapters || []).filter(c => c.start <= t).pop();
  tip.hidden = false;
  tip.textContent = (chapter ? chapter.title + " · " : "") + clock(t);
  tip.style.left = `${Math.max(7, Math.min(93, f * 100))}%`;
  if (seeking) seekTo(t);
});
seek.addEventListener("pointerup", () => { seeking = false; });
seek.addEventListener("pointerleave", () => { if (!seeking) $("seekTip").hidden = true; });

// controls
$("playBtn").onclick = togglePlay;
V.addEventListener("click", () => { document.body.classList.contains("mini") ? location.hash = `#/watch/${current.id}` : togglePlay(); });
V.addEventListener("dblclick", toggleFull);
$("nextBtn").onclick = () => step(1);
$("prevBtn").onclick = () => step(-1);
$("muteBtn").onclick = () => { store.set("muted", !store.get("muted", false)); applyVolume(); };
$("vol").oninput = () => { store.set("volume", +$("vol").value); store.set("muted", false); applyVolume(); };
$("rateSel").onchange = () => { const r = +$("rateSel").value; store.set("rate", r); V.playbackRate = r; A.playbackRate = r; };
$("qualSel").onchange = async () => {
  const q = +$("qualSel").value, at = V.currentTime, wasPaused = V.paused, token = loadToken;
  store.set("quality", q);
  try {
    const d = await api(`/api/video/${current.id}?quality=${q}`);
    if (token === loadToken) applySources(d.sources, at, !wasPaused);
  } catch (e) { fail(e); }
};
function toggleFull() { document.fullscreenElement ? document.exitFullscreen() : player.requestFullscreen().catch(() => {}); }
$("fsBtn").onclick = toggleFull;
$("miniOpen").onclick = () => { if (current) location.hash = `#/watch/${current.id}`; };
$("miniClose").onclick = () => {
  savePosition();
  loadToken++;
  clearMedia();
  current = null; sources = null;
  document.body.classList.remove("mini");
  $("watch").hidden = true;
};

function drawQuality(s) {
  const opts = (s.heights || []).length ? s.heights : [s.height];
  $("qualSel").innerHTML = opts.map(h => `<option value="${h}">${h}p</option>`).join("");
  $("qualSel").value = s.height;
  $("qualSel").hidden = opts.length < 2;
}

let idleTimer;
function wake() {
  player.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!V.paused) player.classList.add("idle"); }, 2800);
}
player.addEventListener("mousemove", wake);
player.addEventListener("mouseleave", () => { if (!V.paused) player.classList.add("idle"); });
V.addEventListener("pause", wake);

function mediaSession(d) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: d.title, artist: d.channel || "", artwork: [{ src: bigThumb(d.id), sizes: "480x360", type: "image/jpeg" }] });
  navigator.mediaSession.setActionHandler("nexttrack", () => step(1));
  navigator.mediaSession.setActionHandler("previoustrack", () => step(-1));
}

function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}
function ymd(s) {
  if (!s || s.length !== 8) return "";
  return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function drawInfo(d) {
  const box = $("watchInfo");
  if (!d) {
    box.innerHTML = current.title ? `<h1>${esc(current.title)}</h1><div class="byline"><span class="name">${esc(current.channel || "")}</span></div>` : '<div class="skel"><div class="line"></div><div class="line"></div></div>';
    return;
  }
  const stats = [d.view_count != null ? compact(d.view_count) + " views" : "", ymd(d.upload_date), d.like_count != null ? compact(d.like_count) + " likes" : ""].filter(Boolean).join(" · ");
  box.innerHTML = `<h1>${esc(d.title)}</h1>
    <div class="byline"><a href="#/channel/${esc(d.channel_id || "")}"><span class="name">${esc(d.channel || "")}</span><small>${d.followers ? compact(d.followers) + " subscribers" : ""}</small></a>
      <button id="wSave"></button><span class="grow"></span>
      <button id="wAdd">${ic("plus", 16)}Save to playlist</button></div>
    ${d.chapters.length ? `<div class="chapters">${d.chapters.map(c => `<button data-at="${c.start}">${clock(c.start)} ${esc(c.title)}</button>`).join("")}</div>` : ""}
    <div class="desc" id="wDesc"><div class="desc-head"><div class="stats">${esc(stats)}</div><button class="ghost" id="wMore">Show description</button></div><pre>${linkify(d.description)}</pre></div>`;
  if (d.channel_id) channelButton($("wSave"), d.channel_id, d.channel_saved, d.channel); else $("wSave").hidden = true;
  $("wAdd").onclick = () => addToPlaylist(known.get(d.id));
  box.querySelectorAll("[data-at]").forEach(b => b.onclick = () => seekTo(+b.dataset.at));
  $("wMore").onclick = () => { const o = $("wDesc").classList.toggle("open"); $("wMore").textContent = o ? "Hide description" : "Show description"; };
  $("wMore").hidden = !d.description.trim();
  $("seekMarks").innerHTML = d.duration ? d.chapters.slice(1).map(c => `<i style="left:${c.start / d.duration * 100}%"></i>`).join("") : "";
}

function drawQueue() {
  const i = queueIndex();
  $("prevBtn").disabled = i <= 0;
  $("nextBtn").disabled = i < 0 || i >= queue.items.length - 1;
  if (!queue.items.length) { $("queue").innerHTML = ""; return; }
  const auto = store.get("autoplay", false);
  $("queue").innerHTML = `<div class="q-head"><b title="${esc(queue.label)}">${esc(queue.label)}</b>
    ${queue.advance ? "" : `<label class="toggle"><input type="checkbox" id="qAuto" ${auto ? "checked" : ""}>Autoplay</label>`}</div>
    <div class="rows q-list" data-queue="queue">${queue.items.map(v => `<div class="row ${v.id === current?.id ? "current" : ""}">${thumbHtml(v)}<div class="body"><a class="vtitle" href="#/watch/${v.id}" data-play="${v.id}">${esc(v.title)}</a><div class="vsub">${esc(v.channel || "")}</div></div></div>`).join("")}</div>`;
  const a = $("qAuto");
  if (a) a.onchange = () => store.set("autoplay", a.checked);
}

// ---------- keyboard ----------
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("modal").hidden) { closeModal(); return; }
  if (e.target.matches("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); input.focus(); input.select(); return; }
  if (!current) return;
  const k = e.key.toLowerCase();
  const act = {
    " ": togglePlay, k: togglePlay, f: toggleFull, n: () => step(1), p: () => step(-1),
    m: () => $("muteBtn").click(),
    arrowleft: () => seekTo(V.currentTime - 5), arrowright: () => seekTo(V.currentTime + 5),
    j: () => seekTo(V.currentTime - 10), l: () => seekTo(V.currentTime + 10),
  }[k];
  if (act) { e.preventDefault(); act(); wake(); }
});

// One long-lived connection per open page. When echo-yt was started from the
// app menu, it stops itself once no page holds one (see /api/alive) - this
// also shows a notice if it has stopped while the page is still open, and
// reloads the page when it reconnects to an updated echo-yt.
(function keepAlive() {
  let offlineTimer = null;
  let version = null;
  const es = new EventSource("/api/alive");
  es.addEventListener("version", e => {
    if (version === null) { version = e.data; return; }
    if (e.data === version) return;
    savePosition();
    location.reload();
  });
  es.onopen = () => {
    clearTimeout(offlineTimer);
    offlineTimer = null;
    document.body.classList.remove("app-offline");
  };
  es.onerror = () => {
    if (!offlineTimer) offlineTimer = setTimeout(() => document.body.classList.add("app-offline"), 4000);
  };
})();

applyLook();
refreshRail().then(route);
api("/api/status").then(s => {
  if (!s.ytdlp) toast("yt-dlp isn't installed, so nothing can load. Run ./install.sh again or install it with pacman.", { bad: true, ms: 15000 });
}).catch(() => {});

const checkUpdate = () => api("/api/update").then(u => { $("updateNote").hidden = !u.available; }).catch(() => {});
setTimeout(checkUpdate, 20000);
setInterval(checkUpdate, 3600000);

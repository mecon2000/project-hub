import { state, api, el, toast, humanSize, relTime, setHash } from "./app.js";
import { attachVideo } from "./viewer.js";
import { openCompare } from "./compare.js";

const PAGE = 60;
let items = [];
let total = 0;
let offset = 0;
let loading = false;
let curArea = null;
let onPick = null; // if set, in pick-mode for actions
let updateChipCount = () => {};

export function renderGallery(view, project, opts = {}) {
  onPick = opts.onPick || null;
  if (!project) {
    view.innerHTML = `<div class="empty">No project selected.</div>`;
    return;
  }
  const areaNames = Object.keys(project.areas || {});
  const visible = areaNames.filter((a) => !project.areas[a].hidden);
  const hidden = areaNames.filter((a) => project.areas[a].hidden);
  if (!curArea || !areaNames.includes(curArea)) curArea = state.area || visible[0] || areaNames[0];

  view.innerHTML = `
    <h2>${onPick ? "Pick from Gallery" : "Gallery"}</h2>
    <div class="chip-row" id="areaChips"></div>
    <div class="gallery-status" id="galStatus"></div>
    <div class="gallery-grid" id="galGrid"></div>
    <button class="load-more hidden" id="loadMoreBtn">Load more</button>
    ${onPick ? '<div class="btn-row"><button class="btn" id="pickDoneBtn">Use selected</button></div>' : ""}
  `;

  const chipRow = document.getElementById("areaChips");
  const chips = {};
  function chipFor(a) {
    const c = el(`<button class="chip ${a === curArea ? "active" : ""}">${a}</button>`);
    chips[a] = c;
    c.addEventListener("click", () => {
      curArea = a;
      document.querySelectorAll("#areaChips .chip").forEach((x) => x.classList.remove("active"));
      c.classList.add("active");
      if (!onPick) setHash({ area: a });
      loadArea(project);
    });
    // real file count, fetched lazily
    api(`/api/p/${project.name}/media?area=${encodeURIComponent(a)}&offset=0&limit=1`)
      .then((r) => { c.textContent = `${a} (${r.total})`; })
      .catch(() => {});
    return c;
  }
  visible.forEach((a) => chipRow.appendChild(chipFor(a)));
  updateChipCount = (a, n) => { if (chips[a]) chips[a].textContent = `${a} (${n})`; };
  if (hidden.length) {
    let expanded = false;
    const more = el(`<button class="chip more">more…</button>`);
    more.addEventListener("click", () => {
      expanded = !expanded;
      more.remove();
      if (expanded) hidden.forEach((a) => chipRow.appendChild(chipFor(a)));
    });
    chipRow.appendChild(more);
  }

  document.getElementById("loadMoreBtn").addEventListener("click", () => loadMore(project));
  if (onPick) {
    document.getElementById("pickDoneBtn").addEventListener("click", () => onPick(state.selection));
  }

  loadArea(project);
}

async function loadArea(project) {
  offset = 0; items = []; total = 0;
  document.getElementById("galGrid").innerHTML = "";
  await loadMore(project);
}

async function loadMore(project) {
  if (loading || !curArea) return;
  loading = true;
  try {
    const res = await api(`/api/p/${project.name}/media?area=${encodeURIComponent(curArea)}&offset=${offset}&limit=${PAGE}`);
    total = res.total;
    items = items.concat(res.items);
    offset += res.items.length;
    renderGrid(project);
    const statusEl = document.getElementById("galStatus");
    if (statusEl) statusEl.textContent = `${items.length} of ${total}`;
    updateChipCount(curArea, total);
  } catch (e) { /* toasted */ } finally {
    loading = false;
    // fresh lookup: a hashchange re-render may have replaced the button mid-fetch
    const btn = document.getElementById("loadMoreBtn");
    if (btn) btn.classList.toggle("hidden", offset >= total);
  }
}

function renderGrid(project) {
  const grid = document.getElementById("galGrid");
  grid.innerHTML = "";
  items.forEach((item, idx) => {
    const thumb = el(`<div class="thumb">
      <img loading="lazy" src="/thumb?path=${encodeURIComponent(item.path)}">
      ${item.kind === "video" ? '<span class="badge">▶</span>' : ""}
      ${item.sidecar && item.sidecar.queued_to_sp ? '<span class="badge badge-ig" title="queued to social publisher">📤</span>' : ""}
    </div>`);
    if (onPick) {
      const selected = state.selection.some((s) => s.path === item.path);
      thumb.classList.toggle("selected", selected);
      thumb.addEventListener("click", () => {
        const i = state.selection.findIndex((s) => s.path === item.path);
        if (i >= 0) state.selection.splice(i, 1);
        else state.selection.push(item);
        thumb.classList.toggle("selected");
      });
    } else {
      thumb.addEventListener("click", () => {
        if (comparePick) {
          if (item.kind !== "video") { toast("Tap a video to compare"); return; }
          const first = comparePick;
          cancelComparePick();
          openCompare(first.path, item.path, first.name, item.name);
          return;
        }
        openLightbox(project, idx);
      });
    }
    grid.appendChild(thumb);
  });
}

// ---- Compare pick mode ----
let comparePick = null;
let comparePickKeyHandler = null;

function startComparePick(item) {
  comparePick = item;
  toast("Tap another video to compare");
  comparePickKeyHandler = (e) => { if (e.key === "Escape") cancelComparePick(); };
  document.addEventListener("keydown", comparePickKeyHandler);
}

function cancelComparePick() {
  comparePick = null;
  if (comparePickKeyHandler) document.removeEventListener("keydown", comparePickKeyHandler);
  comparePickKeyHandler = null;
}

// ---- Lightbox ----
let lbIndex = 0;
function openLightbox(project, idx) {
  lbIndex = idx;
  const lb = document.getElementById("lightbox");
  lb.classList.remove("hidden");
  renderLightbox(project);
  history.pushState({ lightbox: true }, "");
  const popHandler = () => { closeLightbox(); window.removeEventListener("popstate", popHandler); };
  window.addEventListener("popstate", popHandler);
  document.addEventListener("keydown", keyHandler);

  function keyHandler(e) {
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") nav(project, -1);
    if (e.key === "ArrowRight") nav(project, 1);
  }
  lb.dataset.keyBound = "1";
  lb._keyHandler = keyHandler;
}

function closeLightbox() {
  const lb = document.getElementById("lightbox");
  lb.classList.add("hidden");
  const vv = lb.querySelector(".video-viewer");
  if (vv && vv._stop) vv._stop();
  lb.innerHTML = "";
  if (lb._keyHandler) document.removeEventListener("keydown", lb._keyHandler);
}

function nav(project, delta) {
  const next = lbIndex + delta;
  if (next < 0 || next >= items.length) return;
  lbIndex = next;
  renderLightbox(project);
}

let touchStartX = null;

function renderLightbox(project) {
  const item = items[lbIndex];
  const lb = document.getElementById("lightbox");
  lb.innerHTML = `
    <div class="lightbox-top">
      <button class="lightbox-close" id="lbClose">✕</button>
      <div class="muted">${lbIndex + 1} / ${items.length}</div>
    </div>
    <div class="lightbox-media">
      <button class="lightbox-nav prev" id="lbPrev">‹</button>
      ${item.kind === "video" ? "" : `<img src="/file?path=${encodeURIComponent(item.path)}">`}
      <button class="lightbox-nav next" id="lbNext">›</button>
    </div>
    <div class="lightbox-info">${item.name} · ${humanSize(item.size)} · ${relTime(item.mtime)}</div>
    <div class="lightbox-actions">
      <button class="btn" id="lbRunAction">Run action…</button>
      ${item.kind === "video" ? '<button class="btn secondary" id="lbCompare">Compare with…</button>' : ""}
      <button class="btn secondary" id="lbToIG">→ IG…</button>
      <button class="btn secondary" id="lbCopyPath">Copy path</button>
      <button class="btn danger" id="lbDelete">Delete</button>
    </div>
    <div class="chip-row hidden" id="lbIGMenu"></div>
    ${item.sidecar && item.sidecar.queued_to_sp
      ? `<div class="muted lightbox-ig-note">📤 queued to IG: ${item.sidecar.queued_to_sp.map((q) => `${q.account} ${q.type}`).join(", ")}</div>` : ""}
  `;
  if (item.kind === "video") {
    const media = lb.querySelector(".lightbox-media");
    attachVideo(media, item.path, { autoplay: true });
  }
  lb._keyHandler = lb._keyHandler; // keep reference
  document.getElementById("lbClose").addEventListener("click", () => history.back());
  document.getElementById("lbPrev").addEventListener("click", () => nav(project, -1));
  document.getElementById("lbNext").addEventListener("click", () => nav(project, 1));
  document.getElementById("lbRunAction").addEventListener("click", () => {
    if (!state.selection.some((s) => s.path === item.path)) state.selection.push(item);
    setHash({ tab: "actions" });
  });
  const cmpBtn = document.getElementById("lbCompare");
  if (cmpBtn) {
    cmpBtn.addEventListener("click", () => {
      startComparePick(item);
      history.back();
    });
  }
  document.getElementById("lbToIG").addEventListener("click", async () => {
    const menu = document.getElementById("lbIGMenu");
    if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
    menu.innerHTML = "";
    let accounts = [];
    try { accounts = await api("/api/sp/accounts"); } catch (e) { return; }
    for (const acct of accounts) {
      for (const type of ["post", "story"]) {
        const b = el(`<button class="chip">${acct} ${type}</button>`);
        b.addEventListener("click", async () => {
          menu.classList.add("hidden");
          try {
            await api("/api/sp/queue-image", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: item.path, account: acct, type }),
            });
            item.sidecar = item.sidecar || {};
            (item.sidecar.queued_to_sp = item.sidecar.queued_to_sp || []).push({ account: acct, type });
            toast(`Queued as ${acct} ${type} — review + caption it in the Queue tab`);
            renderLightbox(project);
          } catch (e) { /* toasted */ }
        });
        menu.appendChild(b);
      }
    }
    menu.classList.remove("hidden");
  });
  document.getElementById("lbCopyPath").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(item.path); toast("Path copied"); }
    catch (e) { toast("Copy failed"); }
  });
  document.getElementById("lbDelete").addEventListener("click", async () => {
    if (!confirm(`Delete ${item.name}? This moves it to trash.`)) return;
    try {
      await api(`/api/p/${project.name}/delete`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: item.path }),
      });
      items.splice(lbIndex, 1);
      total -= 1;
      updateChipCount(curArea, total);
      const statusEl = document.getElementById("galStatus");
      if (statusEl) statusEl.textContent = `${items.length} of ${total}`;
      toast("Deleted");
      if (!items.length) { history.back(); renderGrid(project); return; }
      if (lbIndex >= items.length) lbIndex = items.length - 1;
      renderGrid(project);
      renderLightbox(project);
    } catch (e) { /* toasted */ }
  });

  const media = lb.querySelector(".lightbox-media");
  media.addEventListener("touchstart", (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
  media.addEventListener("touchend", (e) => {
    if (touchStartX == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50) nav(project, dx < 0 ? 1 : -1);
    touchStartX = null;
  }, { passive: true });
}

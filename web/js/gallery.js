import { state, api, el, toast, humanSize, relTime, setHash } from "./app.js";

const PAGE = 60;
let items = [];
let total = 0;
let offset = 0;
let loading = false;
let curArea = null;
let onPick = null; // if set, in pick-mode for actions

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
    <button class="load-more" id="loadMoreBtn">Load more</button>
    ${onPick ? '<div class="btn-row"><button class="btn" id="pickDoneBtn">Use selected</button></div>' : ""}
  `;

  const chipRow = document.getElementById("areaChips");
  function chipFor(a) {
    const c = el(`<button class="chip ${a === curArea ? "active" : ""}">${a} (${project.areas[a].media.length || ""})</button>`);
    c.addEventListener("click", () => {
      curArea = a;
      if (!onPick) setHash({ area: a });
      loadArea(project);
    });
    return c;
  }
  visible.forEach((a) => chipRow.appendChild(chipFor(a)));
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
  const btn = document.getElementById("loadMoreBtn");
  if (btn) btn.disabled = true;
  try {
    const res = await api(`/api/p/${project.name}/media?area=${encodeURIComponent(curArea)}&offset=${offset}&limit=${PAGE}`);
    total = res.total;
    items = items.concat(res.items);
    offset += res.items.length;
    renderGrid(project);
    const statusEl = document.getElementById("galStatus");
    if (statusEl) statusEl.textContent = `${items.length} of ${total}`;
    if (btn) btn.classList.toggle("hidden", offset >= total);
  } catch (e) { /* toasted */ } finally {
    loading = false;
    if (btn) btn.disabled = false;
  }
}

function renderGrid(project) {
  const grid = document.getElementById("galGrid");
  grid.innerHTML = "";
  items.forEach((item, idx) => {
    const thumb = el(`<div class="thumb">
      <img loading="lazy" src="/thumb?path=${encodeURIComponent(item.path)}">
      ${item.kind === "video" ? '<span class="badge">▶</span>' : ""}
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
      thumb.addEventListener("click", () => openLightbox(project, idx));
    }
    grid.appendChild(thumb);
  });
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
  const mediaHtml =
    item.kind === "video"
      ? `<video src="/file?path=${encodeURIComponent(item.path)}" controls autoplay playsinline></video>`
      : `<img src="/file?path=${encodeURIComponent(item.path)}">`;
  lb.innerHTML = `
    <div class="lightbox-top">
      <button class="lightbox-close" id="lbClose">✕</button>
      <div class="muted">${lbIndex + 1} / ${items.length}</div>
    </div>
    <div class="lightbox-media">
      <button class="lightbox-nav prev" id="lbPrev">‹</button>
      ${mediaHtml}
      <button class="lightbox-nav next" id="lbNext">›</button>
    </div>
    <div class="lightbox-info">${item.name} · ${humanSize(item.size)} · ${relTime(item.mtime)}</div>
    <div class="lightbox-actions">
      <button class="btn" id="lbRunAction">Run action…</button>
      <button class="btn secondary" id="lbCopyPath">Copy path</button>
      <button class="btn danger" id="lbDelete">Delete</button>
    </div>
  `;
  lb._keyHandler = lb._keyHandler; // keep reference
  document.getElementById("lbClose").addEventListener("click", () => history.back());
  document.getElementById("lbPrev").addEventListener("click", () => nav(project, -1));
  document.getElementById("lbNext").addEventListener("click", () => nav(project, 1));
  document.getElementById("lbRunAction").addEventListener("click", () => {
    if (!state.selection.some((s) => s.path === item.path)) state.selection.push(item);
    setHash({ tab: "actions" });
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

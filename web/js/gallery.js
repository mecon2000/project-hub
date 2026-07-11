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

function sidecarInfoHtml(item) {
  const sc = item.sidecar;
  if (!sc) return "";
  const bits = [];
  if (sc.model) bits.push(`<b>${sc.model}</b>`);
  if (sc.session_date) bits.push(`${sc.session_date}${sc.location ? " · " + sc.location : ""}`);
  if (sc.lr_rating != null) bits.push("★".repeat(Math.round(sc.lr_rating)) || "☆");
  if (sc.source_kind) bits.push(String(sc.source_kind).startsWith("camera_jpeg")
    ? "📷 camera JPEG (unedited)" : sc.source_kind);
  if (sc.consent_rule) bits.push(`consent: ${sc.consent_rule}`);
  if (sc.vote) bits.push(sc.vote === "good" ? "👍" : "👎");
  if (sc.lr_keywords) {
    const kw = String(sc.lr_keywords).replace(/[\[\]"]/g, "");
    bits.push(`<span class="muted">${kw.slice(0, 80)}${kw.length > 80 ? "…" : ""}</span>`);
  }
  return bits.length ? `<div class="lightbox-sidecar">${bits.join(" · ")}</div>` : "";
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
    ${sidecarInfoHtml(item)}
    <div class="lightbox-actions">
      <button class="btn secondary" id="lbFav">${item.sidecar && item.sidecar.fav ? "★ Faved" : "☆ Fav"}</button>
      <button class="btn secondary" id="lbGood">👍</button>
      <button class="btn secondary" id="lbBad">👎</button>
      <button class="btn" id="lbRunAction">Run action…</button>
      ${item.kind === "video" ? '<button class="btn secondary" id="lbCompare">Compare with…</button>' : ""}
      <button class="btn secondary" id="lbToIG">→ IG…</button>
      ${item.sidecar && item.sidecar.catalog_photo_id ? '<button class="btn secondary" id="lbFixData">Fix data…</button>' : ""}
      <button class="btn secondary" id="lbCopyPath">Copy path</button>
      <button class="btn danger" id="lbDelete">Delete</button>
    </div>
    <div class="chip-row hidden" id="lbIGMenu"></div>
    <div class="chip-row hidden" id="lbFixMenu"></div>
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
  const fixBtn = document.getElementById("lbFixData");
  if (fixBtn) {
    const FIXES = [
      ["photo_nsfw", "Photo is NSFW", false],
      ["photo_safe", "Photo is SFW ✓ (override)", false],
      ["session_nsfw", "Whole SESSION is NSFW", true],
      ["consent_per_photo", "Model → per-photo consent", true],
      ["consent_anon", "Model → anon only", true],
      ["consent_no", "Model → never publish", true],
    ];
    fixBtn.addEventListener("click", async () => {
      const menu = document.getElementById("lbFixMenu");
      if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
      menu.innerHTML = `<span class="muted">loading current state…</span>`;
      menu.classList.remove("hidden");
      let st = {};
      try { st = await api(`/api/catalog/status?path=${encodeURIComponent(item.path)}`); }
      catch (e) { /* toasted */ }
      menu.innerHTML = "";
      const cur = [];
      if (st.photo_boldness) cur.push(`photo: ${st.photo_boldness.join(", ")}`);
      if (st.set_explicit != null) cur.push(`set: ${st.set_explicit ? "explicit" : "not explicit"}`);
      if (st.session_explicit_sets) cur.push(`session: ${st.session_explicit_sets} sets explicit`);
      if (st.consent) cur.push(`consent: ${st.consent}${st.consent_confirmed ? "" : " (unconfirmed)"}`);
      if (st.photo_consent) cur.push(`this photo: ${st.photo_consent}`);
      if (cur.length) menu.appendChild(el(`<div class="fix-current">NOW → ${cur.join(" · ")}</div>`));
      const isCur = (action) =>
        (action === "photo_nsfw" && (st.photo_boldness || []).some((x) => x.startsWith("explicit"))) ||
        (action === "photo_safe" && (st.photo_boldness || []).some((x) => x.startsWith("safe"))) ||
        (action === "session_nsfw" && st.session_explicit_sets &&
          st.session_explicit_sets.split("/")[0] === st.session_explicit_sets.split("/")[1]) ||
        (action === "consent_per_photo" && st.consent === "per_photo") ||
        (action === "consent_anon" && st.consent === "anon_only") ||
        (action === "consent_no" && st.consent === "no");
      for (const [action, label, confirmFirst] of FIXES) {
        const b = el(`<button class="chip ${isCur(action) ? "active" : ""}">${label}${isCur(action) ? " ✓" : ""}</button>`);
        b.addEventListener("click", async () => {
          menu.classList.add("hidden");
          if (confirmFirst && !confirm(`${label} — apply to the catalog/allowlist?`)) return;
          try {
            const r = await api("/api/catalog/correct", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: item.path, action }),
            });
            toast(r.note || "corrected");
          } catch (e) { /* toasted */ }
        });
        menu.appendChild(b);
      }
    });
  }
  async function voteBtn(id, vote, patch, msg) {
    document.getElementById(id).addEventListener("click", async () => {
      try {
        await api(`/api/p/${project.name}/vote`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: item.path, vote }),
        });
        item.sidecar = Object.assign(item.sidecar || {}, patch);
        toast(msg);
        renderLightbox(project);
      } catch (e) { /* toasted */ }
    });
  }
  voteBtn("lbFav", "fav", { fav: true }, "★ Copied to favorites (with reconstruction command)");
  voteBtn("lbGood", "good", { vote: "good" }, "Voted 👍");
  voteBtn("lbBad", "bad", { vote: "bad" }, "Voted 👎");
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
          const post = async (confirmFlag) => fetch("/api/sp/queue-image", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: item.path, account: acct, type, confirm: confirmFlag }),
          });
          try {
            let res = await post(false);
            if (res.status === 409) {
              const j = await res.json();
              const msg = `⚠️ Consent check: ${j.model} is "${j.status}"` +
                (j.notes ? `\n\n${j.notes}` : "") + `\n\nQueue anyway? (You are the gate.)`;
              if (!confirm(msg)) return;
              res = await post(true);
            }
            if (!res.ok) { const j = await res.json(); toast(j.error || "failed"); return; }
            item.sidecar = item.sidecar || {};
            (item.sidecar.queued_to_sp = item.sidecar.queued_to_sp || []).push({ account: acct, type });
            toast(`Queued as ${acct} ${type} — review + caption it in the Queue tab`);
            renderLightbox(project);
          } catch (e) { toast("queue failed"); }
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

import { api, el, toast } from "./app.js";

let lanes = [];
let filter = { kind: null, subtype: null };   // persists across tab switches

export async function renderQueue(view) {
  view.innerHTML = `<h2>Queue</h2>
    <div class="chip-row" id="queueFilters"></div>
    <div id="queueBody"><div class="muted">Loading…</div></div>`;
  const body = document.getElementById("queueBody");
  try {
    lanes = await api("/api/sp/queues");
  } catch (e) {
    body.innerHTML = `<div class="empty">Failed to load queues.</div>`;
    return;
  }
  if (!lanes.length) {
    body.innerHTML = `<div class="empty">No queues.</div>`;
    return;
  }
  renderFilters();
  renderBody();
}

function renderFilters() {
  const bar = document.getElementById("queueFilters");
  if (!bar) return;
  bar.innerHTML = "";
  const subCounts = new Map();
  for (const lane of lanes) {
    for (const card of lane.items || []) {
      const s = card.subtype || card.type || "other";
      subCounts.set(s, (subCounts.get(s) || 0) + 1);
    }
  }
  const chip = (label, active, onTap) => {
    const c = el(`<button class="chip ${active ? "active" : ""}">${label}</button>`);
    c.addEventListener("click", () => { onTap(); renderFilters(); renderBody(); });
    return c;
  };
  bar.appendChild(chip("all", !filter.kind && !filter.subtype,
    () => { filter = { kind: null, subtype: null }; }));
  for (const k of ["posts", "stories"]) {
    bar.appendChild(chip(k, filter.kind === k,
      () => { filter.kind = filter.kind === k ? null : k; }));
  }
  for (const [s, n] of [...subCounts.entries()].sort((a, b) => b[1] - a[1])) {
    bar.appendChild(chip(`${s} (${n})`, filter.subtype === s,
      () => { filter.subtype = filter.subtype === s ? null : s; }));
  }
}

function cardMatches(card) {
  if (filter.subtype && (card.subtype || card.type || "other") !== filter.subtype) return false;
  return true;
}

function renderBody() {
  const body = document.getElementById("queueBody");
  if (!body) return;
  body.innerHTML = "";
  let shown = 0;
  lanes.forEach((lane, i) => {
    if (filter.kind && lane.kind !== filter.kind) return;
    const visible = (lane.items || []).filter(cardMatches);
    if (filter.subtype && !visible.length) return;
    body.appendChild(renderLane(lane, i, visible));
    shown++;
  });
  if (!shown) body.innerHTML = `<div class="empty">Nothing matches this filter.</div>`;
}

function laneKey(lane) {
  return `${lane.account}::${lane.kind}`;
}

function renderLane(lane, idx, visibleItems) {
  const items = visibleItems || lane.items || [];
  const sec = el(`<section class="lane" data-lane-idx="${idx}">
    <div class="lane-header">
      <span>${lane.label || lane.account}</span>
      <span class="muted">(${(lane.items || []).length}/${lane.target ?? "?"}${items.length !== (lane.items || []).length ? `, showing ${items.length}` : ""})</span>
      <button class="chip lane-topup" title="add 2 auto items">+2</button>
    </div>
    <div class="lane-busy hidden"><div class="spinner"></div><span>removing + refilling…</span></div>
    <div class="lane-cards"></div>
  </section>`);
  sec.querySelector(".lane-topup").addEventListener("click", async () => {
    try {
      const r = await api("/api/p/social-publisher/action/topup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources: [], flags: [],
          params: { account: lane.account, kind: lane.kind, count: 2 } }),
      });
      toast(`Top-up job started (${lane.account} ${lane.kind}) — cards appear when it finishes; see Jobs (${r.job})`);
    } catch (e) { /* toasted */ }
  });
  const cardsEl = sec.querySelector(".lane-cards");
  // group cards by subtype (quote / lyric / found / shoutout / …) with sub-headers
  const groups = new Map();
  items.forEach((card) => {
    const key = card.subtype || card.type || "other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  });
  for (const [sub, cards] of groups) {
    if (groups.size > 1) {
      cardsEl.appendChild(el(`<div class="lane-subheader">${sub} <span class="muted">(${cards.length})</span></div>`));
    }
    cards.forEach((card) => cardsEl.appendChild(renderCard(card, lane, idx)));
  }
  return sec;
}

function replaceLane(idx, newLane) {
  lanes[idx] = newLane;
  renderFilters();   // counts changed
  renderBody();      // re-applies the active filter
}

function setLaneBusy(idx, busy) {
  const body = document.getElementById("queueBody");
  const sec = body.querySelector(`section.lane[data-lane-idx="${idx}"]`);
  if (!sec) return;
  sec.querySelector(".lane-busy").classList.toggle("hidden", !busy);
  sec.querySelector(".lane-cards").classList.toggle("hidden", busy);
}

function badge(text) {
  return text ? `<span class="chip qbadge">${text}</span>` : "";
}

function renderCard(card, lane, laneIdx) {
  const img = (card.images && card.images[0]) || null;
  const text = card.caption || card.story_text || card.quote || "";
  const hashtags = (card.hashtags || []).join(" ");
  const handle = card.mention ? card.mention.replace(/^@/, "") : null;
  const c = el(`<div class="q-card" data-id="${card.id}">
    <div class="q-card-busy hidden"><div class="spinner"></div></div>
    <div class="q-card-body">
      <div class="q-top">
        <div class="q-thumb">${img ? `<img src="${img.url}" loading="lazy">` : ""}</div>
        <div class="q-content">
          <div class="chip-row q-badges">
            ${badge(card.type)}${badge(card.subtype)}${badge(card.model)}${card.consent ? badge("consent ✓") : ""}${card.needs_editing ? badge("🛠 needs edit") : ""}
          </div>
          ${handle ? `<div class="q-mention"><a href="https://www.instagram.com/${handle}/" target="_blank" rel="noopener">@${handle} ↗</a></div>` : ""}
          ${card.look_for ? `<div class="q-lookfor">🔎 look for: ${card.look_for}</div>` : ""}
          <div class="q-text" data-clamped>${text}</div>
          ${hashtags ? `<div class="q-hashtags muted">${hashtags}</div>` : ""}
        </div>
      </div>
      <div class="q-edit-row hidden">
        <input type="text" class="q-edit-input" placeholder="what's wrong? e.g. make it punchier">
        <button class="btn secondary q-fix-btn">Fix</button>
      </div>
      <div class="btn-row q-actions">
        <button class="btn secondary q-copy-text">Copy text</button>
        <button class="btn secondary q-copy-path">Copy path</button>
        ${card.needs_editing ? '<button class="btn secondary q-repull-btn">Re-pull export</button>' : ""}
        ${card.subtype === "lyric" || card.subtype === "quote" ? '<button class="btn secondary q-lyric-btn">🎨 Edit card</button>' : ""}
        <button class="btn secondary q-crop-btn">Crop</button>
        <button class="btn secondary q-edit-btn">Edit</button>
        <button class="btn secondary q-posted-btn">Posted ✓</button>
        <button class="btn danger q-remove-btn">Remove</button>
      </div>
    </div>
  </div>`);

  const textEl = c.querySelector(".q-text");
  textEl.addEventListener("click", () => textEl.classList.toggle("expanded"));

  const thumb = c.querySelector(".q-thumb img");
  if (thumb) thumb.addEventListener("click", () => openLightbox(card.images, 0));

  c.querySelector(".q-copy-text").addEventListener("click", () => {
    navigator.clipboard.writeText(card.copy_text || text || "");
    toast("Copied text");
  });
  c.querySelector(".q-copy-path").addEventListener("click", () => {
    navigator.clipboard.writeText(card.folder_win || "");
    toast("Copied path");
  });

  const lyricBtn = c.querySelector(".q-lyric-btn");
  if (lyricBtn) {
    lyricBtn.addEventListener("click", async () => {
      try {
        const st = await api(`/api/sp/lyric/${encodeURIComponent(card.id)}`);
        openLyricEditor(st, card, lane, laneIdx, c);
      } catch (e) { /* toasted */ }
    });
  }

  const repull = c.querySelector(".q-repull-btn");
  if (repull) {
    repull.addEventListener("click", async () => {
      setCardBusy(c, true);
      try {
        const updated = await api("/api/sp/refresh-export", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: card.id }),
        });
        if (updated.error) { toast(updated.error, 5000); setCardBusy(c, false); return; }
        (updated.images || []).forEach((im) => { im.url += `&t=${Date.now()}`; });
        const i = (lane.items || []).findIndex((it) => it.id === card.id);
        if (i >= 0) lane.items[i] = updated;
        c.replaceWith(renderCard(updated, lane, laneIdx));
        toast("Export pulled in — card is post-ready 🎉");
        return;
      } catch (e) { /* toasted */ }
      setCardBusy(c, false);
    });
  }
  c.querySelector(".q-crop-btn").addEventListener("click", async () => {
    setCardBusy(c, true);
    try {
      const r = await api("/api/sp/crop-options", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: card.id }),
      });
      setCardBusy(c, false);
      if (r.error) { toast(r.error); return; }
      openCropPicker(r, card, lane, laneIdx, c);
    } catch (e) { setCardBusy(c, false); }
  });

  const editBtn = c.querySelector(".q-edit-btn");
  const editRow = c.querySelector(".q-edit-row");
  editBtn.addEventListener("click", () => editRow.classList.toggle("hidden"));

  c.querySelector(".q-fix-btn").addEventListener("click", async () => {
    const instruction = c.querySelector(".q-edit-input").value.trim();
    if (!instruction) { toast("Enter an instruction"); return; }
    setCardBusy(c, true);
    try {
      const updated = await api("/api/sp/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: card.id, instruction }),
      });
      if (updated.error) {
        toast(updated.error);
      } else {
        const idxInLane = (lane.items || []).findIndex((it) => it.id === card.id);
        if (idxInLane >= 0) lane.items[idxInLane] = updated;
        const fresh = renderCard(updated, lane, laneIdx);
        c.replaceWith(fresh);
        return;
      }
    } catch (e) { /* toast shown */ }
    setCardBusy(c, false);
  });

  c.querySelector(".q-posted-btn").addEventListener("click", async () => {
    if (!confirm("Mark as posted? (counts toward cadence caps, leaves the queue)")) return;
    setLaneBusy(laneIdx, true);
    try {
      const newLane = await api("/api/sp/posted", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: card.id }),
      });
      toast("Marked posted 🎉");
      replaceLane(laneIdx, newLane);
      return;
    } catch (e) { /* toast shown */ }
    setLaneBusy(laneIdx, false);
  });

  c.querySelector(".q-remove-btn").addEventListener("click", async () => {
    let reasons = {};
    const subtype = card.subtype || card.type || "";
    try { reasons = await api(`/api/sp/remove-reasons?subtype=${encodeURIComponent(subtype)}`); }
    catch (e) { return; }
    const overlay = el(`<div class="lightbox reason-picker">
      <div class="lightbox-top">
        <span class="muted">Why remove? (teaches the system)</span>
        <button class="lightbox-close">✕</button>
      </div>
      <div class="reason-list"></div>
      <textarea class="reason-feedback" rows="2"
        placeholder="optional: tell the writer why — guides future cards (e.g. 'more 80s rock', 'too melancholic')"></textarea>
    </div>`);
    document.body.appendChild(overlay);
    overlay.querySelector(".lightbox-close").addEventListener("click", () => overlay.remove());
    const list = overlay.querySelector(".reason-list");
    for (const [key, label] of Object.entries(reasons)) {
      const b = el(`<button class="btn secondary reason-btn">${label}</button>`);
      b.addEventListener("click", async () => {
        const feedback = overlay.querySelector(".reason-feedback").value.trim();
        overlay.remove();
        if (key === "bad_crop" && !confirm("Tip: the Crop button re-cuts this card from the original. Remove anyway?")) return;
        if (key === "bad_caption" && !confirm("Tip: the Edit button rewrites the caption. Remove anyway?")) return;
        if (key === "block_model" && !confirm(`Block ${card.model || "this model"} from ALL posting and purge their queued cards?`)) return;
        setLaneBusy(laneIdx, true);
        try {
          const newLane = await api("/api/sp/remove", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: card.id, reason: key, feedback }),
          });
          if (newLane.warning) toast(newLane.warning);
          if (newLane.note) toast(newLane.note, 5000);
          replaceLane(laneIdx, newLane);
          return;
        } catch (e) { /* toast shown */ }
        setLaneBusy(laneIdx, false);
      });
      list.appendChild(b);
    }
  });

  return c;
}

function openLyricEditor(st, card, lane, laneIdx, cardEl) {
  const overlay = el(`<div class="lightbox lyric-editor">
    <div class="lightbox-top">
      <span class="muted">Lyric card editor</span>
      <button class="lightbox-close">✕</button>
    </div>
    <div class="lyric-scroll">
      <img class="lyric-preview" src="">
      <div class="lyric-busy hidden"><div class="spinner"></div><span></span></div>
      <label class="muted">Text (newlines = manual breaks)</label>
      <textarea class="lyric-line" rows="3"></textarea>
      <div class="lyric-row">
        <input type="text" class="lyric-credit" placeholder="(Artist)">
        <select class="lyric-placement">
          <option value="bottom">bottom</option>
          <option value="middle">middle</option>
          <option value="top">top</option>
        </select>
        <button class="btn lyric-apply">Apply text</button>
      </div>
      <div class="btn-row">
        <button class="btn secondary lyric-similar">+4 similar art</button>
        <button class="btn secondary lyric-different">+4 totally different</button>
      </div>
      <label class="muted">Art variants (tap one to use it — applies immediately)</label>
      <div class="lyric-variants"></div>
      <button class="btn lyric-done">✓ Done</button>
    </div>
  </div>`);
  document.body.appendChild(overlay);
  const $ = (sel) => overlay.querySelector(sel);
  let state = st;
  let dirty = false;

  function busy(msg) {
    $(".lyric-busy span").textContent = msg || "";
    $(".lyric-busy").classList.toggle("hidden", !msg);
    ["lyric-apply", "lyric-similar", "lyric-different"].forEach((cls) => {
      $("." + cls).disabled = !!msg;
    });
  }

  function paint() {
    $(".lyric-preview").src = state.card_url + `&t=${Date.now()}`;
    $(".lyric-line").value = state.line;
    $(".lyric-credit").value = state.credit;
    $(".lyric-placement").value = state.placement || "bottom";
    const vs = $(".lyric-variants");
    vs.innerHTML = "";
    for (const v of state.variants) {
      const cell = el(`<div class="thumb ${v.selected ? "selected" : ""}" title="${v.style}">
        <img loading="lazy" src="${v.url}&t=${Date.now()}">
        <span class="badge">${v.style}</span></div>`);
      cell.addEventListener("click", async () => {
        if (v.selected) return;
        busy("switching art + re-rendering…");
        try {
          state = await api(`/api/sp/lyric/${encodeURIComponent(card.id)}/select`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: v.file }),
          });
          dirty = true;
          paint();
        } catch (e) { /* toasted */ }
        busy("");
      });
      vs.appendChild(cell);
    }
  }

  $(".lyric-apply").addEventListener("click", async () => {
    busy("rendering text…");
    try {
      state = await api(`/api/sp/lyric/${encodeURIComponent(card.id)}/render`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          line: $(".lyric-line").value,
          credit: $(".lyric-credit").value,
          placement: $(".lyric-placement").value,
        }),
      });
      dirty = true;
      paint();
      toast("Text rendered");
    } catch (e) { /* toasted */ }
    busy("");
  });

  for (const [cls, mode, label] of [["lyric-similar", "similar", "4 similar"],
                                    ["lyric-different", "different", "4 different"]]) {
    $("." + cls).addEventListener("click", async () => {
      busy(`generating ${label} artworks (~1 min)…`);
      try {
        state = await api(`/api/sp/lyric/${encodeURIComponent(card.id)}/variants`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, count: 4 }),
        });
        paint();
        toast(`+4 variants (${state.variants.length} total)`);
      } catch (e) { /* toasted */ }
      busy("");
    });
  }

  function textDirty() {
    return $(".lyric-line").value !== state.line
        || $(".lyric-credit").value !== state.credit
        || $(".lyric-placement").value !== (state.placement || "bottom");
  }

  async function closeEditor() {
    if (textDirty()) {                       // never lose typed-but-unapplied edits
      busy("applying your text…");
      try {
        state = await api(`/api/sp/lyric/${encodeURIComponent(card.id)}/render`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            line: $(".lyric-line").value,
            credit: $(".lyric-credit").value,
            placement: $(".lyric-placement").value,
          }),
        });
        dirty = true;
      } catch (e) { busy(""); return; }      // render failed — stay open, error toasted
    }
    overlay.remove();
    if (dirty) {
      try {
        const lanes2 = await api("/api/sp/queues");
        const fresh = lanes2.find((l) => l.account === lane.account && l.kind === lane.kind);
        if (fresh) replaceLane(laneIdx, fresh);
      } catch (e) { /* stale card view until next refresh */ }
    }
  }

  $(".lightbox-close").addEventListener("click", closeEditor);
  $(".lyric-done").addEventListener("click", closeEditor);

  paint();
}

function openCropPicker(r, card, lane, laneIdx, cardEl) {
  const overlay = el(`<div class="lightbox crop-picker">
    <div class="lightbox-top">
      <span class="muted">Pick a crop (from the original photo)</span>
      <button class="lightbox-close">✕</button>
    </div>
    <div class="crop-scroll">
      <img src="${r.overlay}" class="crop-img">
      <img src="${r.montage}" class="crop-img">
    </div>
    <div class="chip-row crop-choices"></div>
  </div>`);
  document.body.appendChild(overlay);
  overlay.querySelector(".lightbox-close").addEventListener("click", () => overlay.remove());
  const choices = overlay.querySelector(".crop-choices");
  for (const o of r.options) {
    const b = el(`<button class="chip">${o.n} · ${o.name} (${o.fmt})</button>`);
    b.addEventListener("click", async () => {
      overlay.remove();
      setCardBusy(cardEl, true);
      try {
        const updated = await api("/api/sp/crop-apply", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: card.id, box: o.box, fmt: o.fmt }),
        });
        if (updated.error) { toast(updated.error); setCardBusy(cardEl, false); return; }
        // same file path, new pixels — bust the browser cache
        (updated.images || []).forEach((im) => { im.url += `&t=${Date.now()}`; });
        const idxInLane = (lane.items || []).findIndex((it) => it.id === card.id);
        if (idxInLane >= 0) lane.items[idxInLane] = updated;
        cardEl.replaceWith(renderCard(updated, lane, laneIdx));
        toast(`Cropped: ${o.name}`);
        return;
      } catch (e) { /* toasted */ }
      setCardBusy(cardEl, false);
    });
    choices.appendChild(b);
  }
}

function setCardBusy(cardEl, busy) {
  cardEl.querySelector(".q-card-busy").classList.toggle("hidden", !busy);
  cardEl.querySelector(".q-card-body").classList.toggle("hidden", busy);
}

function openLightbox(images, startIdx) {
  if (!images || !images.length) return;
  let idx = startIdx;
  const overlay = el(`<div class="lightbox">
    <div class="lightbox-top">
      <span class="muted">${images[idx].name || ""}</span>
      <button class="lightbox-close">✕</button>
    </div>
    <div class="lightbox-media">
      ${images.length > 1 ? `<button class="lightbox-nav prev">‹</button>` : ""}
      <img src="${images[idx].url}">
      ${images.length > 1 ? `<button class="lightbox-nav next">›</button>` : ""}
    </div>
  </div>`);
  document.body.appendChild(overlay);
  const imgEl = overlay.querySelector("img");
  function show(i) {
    idx = (i + images.length) % images.length;
    imgEl.src = images[idx].url;
    overlay.querySelector(".lightbox-top .muted").textContent = images[idx].name || "";
  }
  overlay.querySelector(".lightbox-close").addEventListener("click", () => overlay.remove());
  const prev = overlay.querySelector(".prev");
  const next = overlay.querySelector(".next");
  if (prev) prev.addEventListener("click", () => show(idx - 1));
  if (next) next.addEventListener("click", () => show(idx + 1));
}

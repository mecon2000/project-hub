import { api, el, toast } from "./app.js";

let lanes = [];

export async function renderQueue(view) {
  view.innerHTML = `<h2>Queue</h2><div id="queueBody"><div class="muted">Loading…</div></div>`;
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
  body.innerHTML = "";
  lanes.forEach((lane, i) => body.appendChild(renderLane(lane, i)));
}

function laneKey(lane) {
  return `${lane.account}::${lane.kind}`;
}

function renderLane(lane, idx) {
  const sec = el(`<section class="lane" data-lane-idx="${idx}">
    <div class="lane-header">
      <span>${lane.label || lane.account}</span>
      <span class="muted">(${(lane.items || []).length}/${lane.target ?? "?"})</span>
    </div>
    <div class="lane-busy hidden"><div class="spinner"></div><span>removing + refilling…</span></div>
    <div class="lane-cards"></div>
  </section>`);
  const cardsEl = sec.querySelector(".lane-cards");
  // group cards by subtype (quote / lyric / found / shoutout / …) with sub-headers
  const groups = new Map();
  (lane.items || []).forEach((card) => {
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
  const body = document.getElementById("queueBody");
  const old = body.querySelector(`section.lane[data-lane-idx="${idx}"]`);
  const fresh = renderLane(newLane, idx);
  if (old) old.replaceWith(fresh);
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
  const c = el(`<div class="q-card" data-id="${card.id}">
    <div class="q-card-busy hidden"><div class="spinner"></div></div>
    <div class="q-card-body">
      <div class="q-thumb">${img ? `<img src="${img.url}" loading="lazy">` : ""}</div>
      <div class="q-content">
        <div class="chip-row q-badges">
          ${badge(card.type)}${badge(card.subtype)}${badge(card.model)}${card.consent ? badge("consent ✓") : ""}
        </div>
        <div class="q-text" data-clamped>${text}</div>
        ${hashtags ? `<div class="q-hashtags muted">${hashtags}</div>` : ""}
        <div class="q-edit-row hidden">
          <input type="text" class="q-edit-input" placeholder="what's wrong? e.g. make it punchier">
          <button class="btn secondary q-fix-btn">Fix</button>
        </div>
        <div class="btn-row">
          <button class="btn secondary q-copy-text">Copy text</button>
          <button class="btn secondary q-copy-path">Copy path</button>
          <span class="q-send-wrap">
            <button class="btn secondary q-send-btn">Send ▾</button>
            <div class="q-send-menu hidden">
              <button data-to="Me">Me</button>
              <button data-to="WQ">WQ</button>
              <button data-to="Mishel">Mishel</button>
            </div>
          </span>
          <button class="btn secondary q-edit-btn">Edit</button>
          <button class="btn danger q-remove-btn">Remove</button>
        </div>
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

  const sendBtn = c.querySelector(".q-send-btn");
  const sendMenu = c.querySelector(".q-send-menu");
  sendBtn.addEventListener("click", () => sendMenu.classList.toggle("hidden"));
  sendMenu.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", async () => {
      sendMenu.classList.add("hidden");
      try {
        await api("/api/sp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: card.id, to: b.dataset.to }),
        });
        toast("sent to phone");
      } catch (e) { /* toast shown */ }
    });
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

  c.querySelector(".q-remove-btn").addEventListener("click", async () => {
    if (!confirm("Remove this item?")) return;
    setLaneBusy(laneIdx, true);
    try {
      const newLane = await api("/api/sp/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: card.id }),
      });
      if (newLane.warning) toast(newLane.warning);
      replaceLane(laneIdx, newLane);
      return;
    } catch (e) { /* toast shown */ }
    setLaneBusy(laneIdx, false);
  });

  return c;
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

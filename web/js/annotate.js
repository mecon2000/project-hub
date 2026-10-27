import { api, el, toast, setHash } from "./app.js";

// Review board for areas whose manifest sets `annotate:`. One card per item (usually a
// group dir = one piece with several images). Each card: image switcher, ⓘ metadata
// (from <group>/meta.json), verdict chips, and Notes → Take One's review-room flow on a still:
// tap the picture to pin, write, Save note (snapshot with the pin drawn in); ✓ done / ✕ delete.
// `more_like_this: true` adds a "＋ More like this" toggle: a request for a few new variations of that item.
// "Send notes" stamps them as sent and runs the area's submit_action.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const base = (p) => String(p).split("/").pop();
// "02_layers.png" -> "layers"; "01_angle_side.jpg" -> "angle side"
const imgLabel = (p) => base(p).replace(/\.[^.]+$/, "").replace(/^\d+[_-]?/, "").replace(/[_-]+/g, " ") || base(p);

export function annotateEnabled(project, area) {
  return !!(project.areas && project.areas[area] && project.areas[area].annotate);
}

function cfgOf(project, area) {
  const a = project.areas[area].annotate;
  return typeof a === "object" && a ? a : {};
}

const unsent = (n) => !!(n && (n.updated_at || 0) > (n.sent_at || 0));

export async function renderBoard(host, project, area) {
  const cfg = cfgOf(project, area);
  const verdicts = cfg.verdicts || ["keep", "drop"];
  host.className = "ann-board";
  host.innerHTML = `<div class="muted">loading…</div>`;
  let items = [];
  try {
    const res = await api(`/api/p/${project.name}/media?area=${encodeURIComponent(area)}&offset=0&limit=200`);
    items = res.items;
  } catch (e) { return; }
  host.innerHTML = "";
  const bar = el(`<div class="ann-bar">
    ${cfg.hint ? `<div class="ann-hint muted">${esc(cfg.hint)}</div>` : ""}
    <div class="ann-bar-row">
      <span class="ann-tally muted" id="annTally"></span>
      <button class="btn" id="annSend">Send notes</button>
    </div>
  </div>`);
  const grid = el(`<div class="ann-grid"></div>`);
  host.append(grid, bar);               // the send bar sticks to the bottom edge (thumb reach on a phone)

  const tally = () => {
    const kept = {}, open = items.filter((it) => unsent(it.notes)).length;
    verdicts.forEach((v) => { kept[v] = items.filter((it) => it.notes && it.notes.verdict === v).length; });
    const more = items.filter((it) => it.notes && it.notes.more).length;
    bar.querySelector("#annTally").textContent =
      verdicts.map((v) => `${v} ${kept[v]}`).join(" · ") + (cfg.more_like_this ? ` · more ${more}` : "") + ` · ${open} unsent`;
    bar.querySelector("#annSend").disabled = !open;
  };

  const renderCard = (it, i) => {
    const imgs = it.kind === "group" ? (it.members || []) : [it.path];
    const n = it.notes || {};
    let cur = it._cur || imgs[0];
    const meta = it.meta || {};
    const title = meta.title || it.name;
    const ns = n.notes || [];
    const open = ns.filter((x) => !x.done).length;
    const card = el(`<article class="ann-card ${n.verdict ? "v-" + esc(n.verdict) : ""}">
      <div class="ann-shot"><img loading="lazy" alt="${esc(title)}"></div>
      <div class="ann-body">
        <div class="ann-head">
          <span class="ann-num">#${i + 1}</span>
          <h3>${esc(title)}</h3>
          ${Object.keys(meta).length ? `<button class="ann-info" aria-label="Details" aria-expanded="false">i</button>` : ""}
        </div>
        <div class="ann-pop hidden" role="tooltip">${Object.entries(meta).filter(([k]) => k !== "title")
          .map(([k, v]) => `<div><span>${esc(k.replace(/_/g, " "))}</span><b>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</b></div>`).join("")}</div>
        ${imgs.length > 1 ? `<div class="ann-views">${imgs.map((p) =>
          `<button class="ann-view ${p === cur ? "on" : ""}" data-p="${esc(p)}">${esc(imgLabel(p))}</button>`).join("")}</div>` : ""}
        ${ns.length ? `<div class="ann-preview" dir="auto"><span class="ann-pinct">${ns.length} note${ns.length > 1 ? "s" : ""}${open < ns.length ? ` · ${open} open` : ""}</span>${esc(ns.filter((x) => !x.done).map((x) => x.text).join(" · ").slice(0, 140))}</div>` : ""}
        <div class="ann-actions">
          ${verdicts.map((v) => `<button class="ann-v ${n.verdict === v ? "on" : ""}" data-v="${esc(v)}">${esc(v)}</button>`).join("")}
          <button class="ann-edit">✎ Notes${unsent(n) ? " •" : ""}</button>
          ${cfg.more_like_this ? `<button class="ann-more ${n.more ? "on" : ""}" aria-pressed="${!!n.more}"
            title="Ask for a few new variations of this one">${n.more ? "✓ More like this" : "＋ More like this"}</button>` : ""}
        </div>
      </div>
    </article>`);
    const img = card.querySelector(".ann-shot img");
    img.src = `/file?path=${encodeURIComponent(cur)}`;
    card.querySelectorAll(".ann-view").forEach((b) => b.addEventListener("click", () => {
      cur = it._cur = b.dataset.p;
      img.src = `/file?path=${encodeURIComponent(cur)}`;
      card.querySelectorAll(".ann-view").forEach((x) => x.classList.toggle("on", x === b));
    }));
    const info = card.querySelector(".ann-info"), pop = card.querySelector(".ann-pop");
    if (info) {
      const show = (on) => { pop.classList.toggle("hidden", !on); info.setAttribute("aria-expanded", String(on)); };
      info.addEventListener("click", (e) => { e.stopPropagation(); show(pop.classList.contains("hidden")); });
      if (matchMedia("(hover: hover)").matches) {
        info.addEventListener("mouseenter", () => show(true));
        info.addEventListener("mouseleave", () => show(false));
      }
    }
    card.querySelectorAll(".ann-v").forEach((b) => b.addEventListener("click", async () => {
      const v = n.verdict === b.dataset.v ? "" : b.dataset.v;
      try {
        const r = await api(`/api/p/${project.name}/notes`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ area, path: it.path, op: "verdict", verdict: v }),
        });
        it.notes = r.notes; redraw(i); tally();
      } catch (e) { /* toasted */ }
    }));
    card.querySelector(".ann-more")?.addEventListener("click", async () => {
      try {
        const r = await api(`/api/p/${project.name}/notes`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ area, path: it.path, op: "more", more: !n.more }),
        });
        it.notes = r.notes; redraw(i); tally();
        toast(r.notes.more ? "Asked for more like this — goes out with Send notes" : "Request removed");
      } catch (e) { /* toasted */ }
    });
    card.querySelector(".ann-edit").addEventListener("click", () =>
      openEditor(project, area, it, imgs, cur, title, () => { redraw(i); tally(); }));
    img.addEventListener("click", () =>
      openEditor(project, area, it, imgs, cur, title, () => { redraw(i); tally(); }));
    return card;
  };
  const cards = [];
  const redraw = (i) => { const c = renderCard(items[i], i); cards[i].replaceWith(c); cards[i] = c; };
  items.forEach((it, i) => { cards[i] = renderCard(it, i); grid.appendChild(cards[i]); });
  if (!host._popCloser) {               // tap anywhere else closes an open ⓘ panel
    host._popCloser = true;
    document.addEventListener("click", () => host.querySelectorAll(".ann-pop").forEach((p) => p.classList.add("hidden")));
  }
  tally();

  bar.querySelector("#annSend").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const r = await api(`/api/p/${project.name}/notes/submit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area }),
      });
      toast(r.job ? `Sent ${r.sent} — job started` : `Marked ${r.sent} as sent`);
      renderBoard(host, project, area);
      if (r.job) setTimeout(() => setHash({ tab: "jobs", job: r.job }), 900);
    } catch (err) { e.target.disabled = false; }
  });
}

// ---------------------------------------------------------------- editor
// The Take One review-room flow, on a still: tap the picture to pin, write, Save note.
// Each note is saved at once with a snapshot (pin drawn in); ✓ marks it done, ✕ removes it.
function openEditor(project, area, it, imgs, start, title, onChanged) {
  let d = it.notes || { notes: [] };
  let cur = start, pin = null, mode = "pin", focus = null;
  const dir = it.kind === "group" ? it.path : it.path.replace(/\/[^/]*$/, "");
  const imgFor = (n) => imgs.find((m) => base(m) === n.img) || imgs[0];
  const ov = el(`<div class="ann-editor" role="dialog" aria-label="Notes">
    <div class="ann-ed-top">
      <button class="ann-ed-close" aria-label="Close">✕</button>
      <div class="ann-ed-title">${esc(title)}</div>
    </div>
    <div class="ann-ed-body">
      <section class="ann-ed-left">
        ${imgs.length > 1 ? `<div class="ann-views ann-ed-views"></div>` : ""}
        <div class="ann-stage"><div class="ann-frame"><img alt=""><div class="ann-pins"></div></div></div>
        <div class="ann-ed-hint muted">Tap the picture to pin a note to that spot.</div>
      </section>
      <aside class="ann-ed-right">
        <div class="ann-compose">
          <div class="ann-where"></div>
          <textarea id="annText" dir="auto" rows="3" placeholder="What should change?"></textarea>
          <div class="ann-row">
            <button class="btn" id="annAdd">Save note</button>
            <button class="btn secondary" id="annWhole">Note on the whole piece</button>
          </div>
        </div>
        <div class="ann-list"></div>
      </aside>
    </div>
  </div>`);
  document.body.appendChild(ov);
  document.body.classList.add("ann-lock");
  const img = ov.querySelector(".ann-frame img"), layer = ov.querySelector(".ann-pins");
  const views = ov.querySelector(".ann-ed-views"), list = ov.querySelector(".ann-list");
  const where = ov.querySelector(".ann-where"), text = ov.querySelector("#annText");

  const setWhere = () => {
    where.textContent = mode === "whole" ? "Note on the whole piece"
      : pin ? `Pinned on ${imgLabel(cur)}` : "Tap the picture, or write a note on the whole piece.";
  };
  const drawViews = () => {
    if (!views) return;
    views.innerHTML = imgs.map((p) => {
      const c = d.notes.filter((q) => q.x != null && imgFor(q) === p && !q.done).length;
      return `<button class="ann-view ${p === cur ? "on" : ""}" data-p="${esc(p)}">${esc(imgLabel(p))}${c ? ` · ${c}` : ""}</button>`;
    }).join("");
    views.querySelectorAll(".ann-view").forEach((b) => b.addEventListener("click", () => {
      cur = b.dataset.p; pin = null; if (mode === "pin") setWhere(); draw();
    }));
  };
  const drawPins = () => {
    layer.innerHTML = "";
    d.notes.forEach((n, k) => {
      if (n.x == null || imgFor(n) !== cur) return;
      layer.appendChild(el(`<div class="ann-pin old ${n.done ? "done" : ""} ${focus === n.id ? "focus" : ""}" style="left:${n.x * 100}%;top:${n.y * 100}%">${k + 1}</div>`));
    });
    if (pin) layer.appendChild(el(`<div class="ann-pin new" style="left:${pin.x * 100}%;top:${pin.y * 100}%"></div>`));
  };
  const drawList = () => {
    list.innerHTML = d.notes.length ? "" : `<div class="muted ann-empty">No notes on this piece yet.</div>`;
    d.notes.forEach((n, k) => {
      const shot = n.shot ? `/file?path=${encodeURIComponent(dir + "/" + n.shot)}` : null;
      const row = el(`<div class="ann-note ${n.done ? "done" : ""}">
        ${shot ? `<img src="${shot}" alt="" loading="lazy">` : `<div class="ann-noshot">whole<br>piece</div>`}
        <div class="ann-note-body">
          <div class="ann-note-meta"><b>${k + 1}</b> · ${n.x != null ? esc(imgLabel(imgFor(n))) : "whole piece"}</div>
          <p dir="auto">${esc(n.text)}</p>
          <div class="ann-note-acts">
            <button data-a="done">${n.done ? "↺ reopen" : "✓ done"}</button>
            <button data-a="del">✕ delete</button>
          </div>
        </div>
      </div>`);
      const show = () => { if (n.x == null) return; cur = imgFor(n); focus = n.id; draw(); ov.querySelector(".ann-stage").scrollIntoView({ behavior: "smooth", block: "nearest" }); };
      row.querySelector("img")?.addEventListener("click", show);
      row.querySelector(".ann-note-meta").addEventListener("click", show);
      row.querySelector('[data-a="done"]').addEventListener("click", () => send({ op: "update", id: n.id, done: !n.done }));
      row.querySelector('[data-a="del"]').addEventListener("click", () => {
        if (window.confirm(`Delete note ${k + 1}?`)) send({ op: "delete", id: n.id });
      });
      list.appendChild(row);
    });
  };
  const draw = () => {
    const src = `/file?path=${encodeURIComponent(cur)}`;
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    drawViews(); drawPins(); drawList();
  };
  const send = async (body) => {
    try {
      const r = await api(`/api/p/${project.name}/notes`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area, path: it.path, ...body }),
      });
      d = it.notes = r.notes;
      draw(); onChanged && onChanged();
      return true;
    } catch (e) { return false; }
  };
  // snapshot of the picture with the pin drawn in, so a note reads on its own later
  const snapshot = () => {
    try {
      const k = Math.min(1, 900 / img.naturalWidth), W = Math.round(img.naturalWidth * k), H = Math.round(img.naturalHeight * k);
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0, W, H);
      if (pin) { g.lineWidth = 5; g.strokeStyle = "#fff"; g.fillStyle = "#d97757"; g.beginPath(); g.arc(pin.x * W, pin.y * H, 15, 0, 7); g.fill(); g.stroke(); }
      return c.toDataURL("image/jpeg", 0.85);
    } catch (e) { return null; }
  };

  img.addEventListener("click", (e) => {
    const r = img.getBoundingClientRect();
    pin = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    mode = "pin"; focus = null; setWhere(); drawPins();
    text.focus({ preventScroll: true });
    if (matchMedia("(max-width: 899px)").matches) text.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  ov.querySelector("#annWhole").addEventListener("click", () => { mode = "whole"; pin = null; setWhere(); drawPins(); text.focus(); });
  ov.querySelector("#annAdd").addEventListener("click", async () => {
    const t = text.value.trim();
    if (!t) { text.focus(); return; }
    const body = { op: "add", text: t };
    if (mode !== "whole" && pin) Object.assign(body, { img: base(cur), x: pin.x, y: pin.y, shot: snapshot() });
    if (await send(body)) { text.value = ""; pin = null; mode = "pin"; setWhere(); drawPins(); toast("Note saved"); }
  });
  const close = () => {
    if (text.value.trim() && !window.confirm("Discard the note you are writing?")) return;
    ov.remove(); document.body.classList.remove("ann-lock"); document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  ov.querySelector(".ann-ed-close").addEventListener("click", close);
  setWhere(); draw();
}

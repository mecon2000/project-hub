import { api, el, toast, setHash } from "./app.js";

// Review board for areas whose manifest sets `annotate:`. One card per item (usually a
// group dir = one piece with several images). Each card: image switcher, ⓘ metadata
// (from <group>/meta.json), verdict chips, and Edit → a full-screen editor where taps on
// the image drop numbered pins, each with its own text, plus a general note.
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

const unsent = (n) => !!(n && (n.updated_at || 0) > (n.sent_at || 0) &&
  (n.verdict || (n.note || "").trim() || (n.pins || []).length));

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
    bar.querySelector("#annTally").textContent =
      verdicts.map((v) => `${v} ${kept[v]}`).join(" · ") + ` · ${open} unsent`;
    bar.querySelector("#annSend").disabled = !open;
  };

  const renderCard = (it, i) => {
    const imgs = it.kind === "group" ? (it.members || []) : [it.path];
    const n = it.notes || {};
    let cur = it._cur || imgs[0];
    const meta = it.meta || {};
    const title = meta.title || it.name;
    const pins = n.pins || [];
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
        ${(n.note || pins.length) ? `<div class="ann-preview">${pins.length ? `<span class="ann-pinct">📍${pins.length}</span>` : ""}${esc((n.note || pins.map((p) => p.text).join(" · ")).slice(0, 140))}</div>` : ""}
        <div class="ann-actions">
          ${verdicts.map((v) => `<button class="ann-v ${n.verdict === v ? "on" : ""}" data-v="${esc(v)}">${esc(v)}</button>`).join("")}
          <button class="ann-edit">✎ Edit${unsent(n) ? " •" : ""}</button>
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
          body: JSON.stringify({ area, path: it.path, verdict: v }),
        });
        it.notes = r.notes; redraw(i); tally();
      } catch (e) { /* toasted */ }
    }));
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
function openEditor(project, area, it, imgs, start, title, onSaved) {
  const n = it.notes || {};
  let pins = (n.pins || []).map((p) => ({ ...p }));
  let cur = start;
  const resolveImg = (p) => imgs.find((m) => base(m) === p.img) || imgs[0];
  const ov = el(`<div class="ann-editor" role="dialog" aria-label="Edit notes">
    <div class="ann-ed-top">
      <button class="ann-ed-close" aria-label="Close">✕</button>
      <div class="ann-ed-title">${esc(title)}</div>
      <button class="btn" id="annSave">Save</button>
    </div>
    <div class="ann-ed-scroll">
      ${imgs.length > 1 ? `<div class="ann-views ann-ed-views"></div>` : ""}
      <div class="ann-stage"><div class="ann-frame"><img alt=""><div class="ann-pins"></div></div></div>
      <div class="ann-ed-hint muted">Tap the picture to drop a pin, then say what to change there.</div>
      <ol class="ann-pinlist"></ol>
      <label class="ann-label" for="annNote">General note</label>
      <textarea id="annNote" rows="4" placeholder="What should change overall?">${esc(n.note || "")}</textarea>
    </div>
  </div>`);
  document.body.appendChild(ov);
  document.body.classList.add("ann-lock");
  const img = ov.querySelector(".ann-frame img"), layer = ov.querySelector(".ann-pins");
  const list = ov.querySelector(".ann-pinlist"), views = ov.querySelector(".ann-ed-views");

  const drawViews = () => {
    if (!views) return;
    views.innerHTML = imgs.map((p) => {
      const c = pins.filter((q) => resolveImg(q) === p).length;
      return `<button class="ann-view ${p === cur ? "on" : ""}" data-p="${esc(p)}">${esc(imgLabel(p))}${c ? ` 📍${c}` : ""}</button>`;
    }).join("");
    views.querySelectorAll(".ann-view").forEach((b) => b.addEventListener("click", () => { cur = b.dataset.p; draw(); }));
  };
  const drawPins = () => {
    layer.innerHTML = "";
    pins.forEach((p, k) => {
      if (resolveImg(p) !== cur) return;
      const d = el(`<button class="ann-pin" style="left:${p.x * 100}%;top:${p.y * 100}%">${k + 1}</button>`);
      d.addEventListener("click", (e) => { e.stopPropagation(); focusPin(k); });
      layer.appendChild(d);
    });
  };
  const focusPin = (k) => {
    const ta = list.querySelector(`[data-k="${k}"] textarea`);
    if (ta) { ta.scrollIntoView({ block: "center", behavior: "smooth" }); ta.focus({ preventScroll: true }); }
  };
  const drawList = () => {
    list.innerHTML = "";
    pins.forEach((p, k) => {
      const li = el(`<li data-k="${k}">
        <div class="ann-pinrow">
          <button class="ann-pinbadge" title="Show on picture">${k + 1}</button>
          <span class="muted">${esc(imgLabel(resolveImg(p)))}</span>
          <button class="ann-pindel" aria-label="Remove pin ${k + 1}">✕</button>
        </div>
        <textarea rows="2" placeholder="What should change here?">${esc(p.text)}</textarea>
      </li>`);
      li.querySelector("textarea").addEventListener("input", (e) => { p.text = e.target.value; });
      li.querySelector(".ann-pinbadge").addEventListener("click", () => {
        cur = resolveImg(p); draw(); ov.querySelector(".ann-stage").scrollIntoView({ behavior: "smooth" });
      });
      li.querySelector(".ann-pindel").addEventListener("click", () => { pins.splice(k, 1); draw(); });
      list.appendChild(li);
    });
  };
  const draw = () => {
    const src = `/file?path=${encodeURIComponent(cur)}`;
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
    drawViews(); drawPins(); drawList();
  };
  img.addEventListener("click", (e) => {
    const r = img.getBoundingClientRect();
    pins.push({ img: base(cur), x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, text: "" });
    draw();
    focusPin(pins.length - 1);
  });

  const close = () => { ov.remove(); document.body.classList.remove("ann-lock"); document.removeEventListener("keydown", onKey); };
  const dirty = () => JSON.stringify(pins) !== JSON.stringify(n.pins || []) ||
    ov.querySelector("#annNote").value !== (n.note || "");
  const onKey = (e) => { if (e.key === "Escape") tryClose(); };
  const tryClose = () => {
    if (dirty() && !window.confirm("Discard the changes you made here?")) return;
    close();
  };
  document.addEventListener("keydown", onKey);
  ov.querySelector(".ann-ed-close").addEventListener("click", tryClose);
  ov.querySelector("#annSave").addEventListener("click", async () => {
    try {
      const r = await api(`/api/p/${project.name}/notes`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area, path: it.path, note: ov.querySelector("#annNote").value,
          pins }),
      });
      it.notes = r.notes;
      it._cur = cur;
      toast("Saved");
      close();
      onSaved && onSaved();
    } catch (e) { /* toasted */ }
  });
  draw();
}

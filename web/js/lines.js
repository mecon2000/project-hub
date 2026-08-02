import { api, el, toast } from "./app.js";

let data = null;
let pollTimers = new Map(); // id -> interval id

export async function renderLines(view) {
  view.innerHTML = `<h2>Lines</h2><div id="linesBody"><div class="muted">Loading…</div></div>`;
  const body = document.getElementById("linesBody");
  try {
    data = await api("/api/sp/lines");
  } catch (e) {
    body.innerHTML = `<div class="empty">Failed to load lines.</div>`;
    return;
  }
  renderBody();
  maybeAutoRefetch();
}

function maybeAutoRefetch(attempt = 0) {
  if (!data) return;
  const fresh = (data.items || []).filter((it) => it.status === "fresh" || it.status === "creating");
  if (fresh.length || data.refilling === false && attempt >= 2) return;
  if (!fresh.length && attempt < 3) {
    setTimeout(async () => {
      if (!document.getElementById("linesBody")) return; // navigated away
      try { data = await api("/api/sp/lines"); } catch (e) { return; }
      renderBody();
      maybeAutoRefetch(attempt + 1);
    }, 5000);
  }
}

function renderBody() {
  const body = document.getElementById("linesBody");
  if (!body) return;
  body.innerHTML = "";

  const header = el(`<div class="lines-header">
    <span>Lines — round ${data.round ?? "?"}</span>
    <button class="btn secondary lines-refill">↻ Refill</button>
  </div>`);
  header.querySelector(".lines-refill").addEventListener("click", async () => {
    try {
      await api("/api/sp/lines/refill", { method: "POST" });
      toast("refill started — new lines in ~2-4 min");
    } catch (e) {
      // api() already toasts network/server errors; handle 409 body if surfaced
    }
  });
  body.appendChild(header);

  if (data.refilling) {
    body.appendChild(el(`<div class="muted lines-refill-banner">refilling in the background…</div>`));
  }

  const items = data.items || [];
  const fresh = items.filter((it) => it.status === "fresh" || it.status === "creating");
  const maybe = items.filter((it) => it.status === "maybe");

  const freshSection = el(`<div class="lines-section"></div>`);
  freshSection.appendChild(el(`<div class="lines-subheader">Fresh</div>`));
  if (!fresh.length && !data.refilling) {
    freshSection.appendChild(el(`<div class="empty">No fresh lines — refill is starting…</div>`));
  } else {
    fresh.forEach((it) => freshSection.appendChild(renderRow(it)));
  }
  body.appendChild(freshSection);

  if (maybe.length) {
    const maybeSection = el(`<div class="lines-section"></div>`);
    maybeSection.appendChild(el(`<div class="lines-subheader">Maybe 🤔</div>`));
    maybe.forEach((it) => maybeSection.appendChild(renderRow(it)));
    body.appendChild(maybeSection);
  }
}

function metaLine(it) {
  if (it.kind === "quote") return it.author ? `— ${it.author}` : "";
  if (it.kind === "lyric") {
    const parts = [it.song, it.artist].filter(Boolean);
    return parts.join(" · ");
  }
  return "";
}

function renderRow(it) {
  const row = el(`<div class="line-row" data-id="${it.id}">
    <div class="line-busy hidden"><div class="spinner"></div><span class="line-busy-note"></span></div>
    <div class="line-main">
      <div class="line-text">${(it.text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>
      <div class="line-meta muted">${metaLine(it)}</div>
      <div class="line-edit hidden">
        <textarea class="line-edit-text" rows="3"></textarea>
        <div class="chip-row line-alt-chips"></div>
      </div>
      <div class="btn-row line-actions">
        <button class="btn secondary line-make-btn">✓ Make card</button>
        <button class="btn secondary line-maybe-btn">${it.status === "maybe" ? "↩ Fresh" : "🤔 Maybe"}</button>
        <button class="btn secondary line-edit-btn">✏️</button>
      </div>
    </div>
  </div>`);

  if (it.status === "creating") {
    setRowCreating(row, "creating…");
  }

  const editBtn = row.querySelector(".line-edit-btn");
  const editBox = row.querySelector(".line-edit");
  const textarea = row.querySelector(".line-edit-text");
  textarea.value = it.text || "";
  editBtn.addEventListener("click", () => editBox.classList.toggle("hidden"));

  const chips = row.querySelector(".line-alt-chips");
  if (it.alt_lines && it.alt_lines.length > 1) {
    it.alt_lines.forEach((alt) => {
      const chip = el(`<button class="chip">${alt.length > 30 ? alt.slice(0, 30) + "…" : alt}</button>`);
      chip.addEventListener("click", () => { textarea.value = alt; });
      chips.appendChild(chip);
    });
  }

  row.querySelector(".line-maybe-btn").addEventListener("click", async () => {
    const newStatus = it.status === "maybe" ? "fresh" : "maybe";
    try {
      await api(`/api/sp/lines/${encodeURIComponent(it.id)}/state`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      it.status = newStatus;
      renderBody();
    } catch (e) { /* toasted */ }
  });

  row.querySelector(".line-make-btn").addEventListener("click", async () => {
    const editOpen = !editBox.classList.contains("hidden");
    const editedText = textarea.value;
    const body = {};
    if (editOpen && editedText !== it.text) body.text = editedText;
    try {
      const r = await api(`/api/sp/lines/${encodeURIComponent(it.id)}/make`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      it.status = "creating";
      setRowCreating(row, "generating 5 artworks…");
      pollJob(r.job, it, row);
    } catch (e) { /* toasted */ }
  });

  return row;
}

function setRowCreating(row, note) {
  row.querySelector(".line-busy").classList.remove("hidden");
  row.querySelector(".line-busy-note").textContent = note;
  row.querySelector(".line-main").classList.add("hidden");
}

function restoreRow(row) {
  row.querySelector(".line-busy").classList.add("hidden");
  row.querySelector(".line-main").classList.remove("hidden");
}

function pollJob(jobId, it, row) {
  const timer = setInterval(async () => {
    let j;
    try {
      j = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    } catch (e) {
      return;
    }
    if (j.status === "done") {
      clearInterval(timer);
      pollTimers.delete(it.id);
      data.items = (data.items || []).filter((x) => x.id !== it.id);
      row.remove();
      toast("Card created → Queue tab");
    } else if (j.status === "failed") {
      clearInterval(timer);
      pollTimers.delete(it.id);
      it.status = "fresh";
      toast("Failed to generate card", 5000);
      restoreRow(row);
    }
  }, 5000);
  pollTimers.set(it.id, timer);
}

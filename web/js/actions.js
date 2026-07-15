import { state, api, el, toast, setHash } from "./app.js";
import { renderGallery } from "./gallery.js";
import { attachVideo } from "./viewer.js";

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|avi|m4v)$/i;

let curAction = null;
let segment = { start: null, end: null };
let segmentViewer = null;

export function renderActions(view, project) {
  if (!project) {
    view.innerHTML = `<div class="empty">No project selected.</div>`;
    return;
  }
  const actionNames = Object.keys(project.actions || {});
  if (!curAction || !actionNames.includes(curAction)) curAction = actionNames[0];

  view.innerHTML = `
    <h2>Actions</h2>
    <div class="field">
      <label>Action</label>
      <select id="actionSelect">${actionNames.map((a) => `<option value="${a}">${project.actions[a].label || a}</option>`).join("")}</select>
    </div>
    <div id="actionBody"></div>
  `;
  const sel = document.getElementById("actionSelect");
  sel.value = curAction;
  sel.addEventListener("change", () => { curAction = sel.value; renderBody(project); });
  renderBody(project);
}

function parseTimeStr(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s) return null;
  const parts = s.split(":").map((p) => parseFloat(p));
  if (parts.some((p) => isNaN(p))) return null;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return secs;
}

function fmtTimeStr(s) {
  if (s == null || !isFinite(s)) return "";
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function renderBody(project) {
  const action = project.actions[curAction];
  const body = document.getElementById("actionBody");
  segment = { start: null, end: null };
  segmentViewer = null;
  if (!action) { body.innerHTML = `<div class="empty">No actions available.</div>`; return; }

  const estBits = [];
  if (action.wall_time_estimate_sec) estBits.push(`~${Math.round(action.wall_time_estimate_sec / 60)} min`);
  if (action.cost_estimate_usd) estBits.push(`~$${action.cost_estimate_usd}`);

  const wantsSources = action.takes_sources !== false;   // undefined (old cache) = show
  body.innerHTML = `
    ${wantsSources ? `<div class="card">
      <h3>Sources</h3>
      <div class="chip-row" id="srcChips"></div>
      <div class="btn-row">
        <button class="btn secondary" id="pickBtn">Pick from gallery</button>
        <button class="btn secondary" id="clearSrcBtn">Clear</button>
      </div>
    </div>
    <div class="card" id="pickerCard"></div>` : ""}
    <div class="card">
      <h3>Parameters</h3>
      <form id="paramsForm"></form>
      ${estBits.length ? `<div class="muted">Estimate: ${estBits.join(" · ")}</div>` : ""}
    </div>
    <div id="segmentCard"></div>
    <div class="card">
      <div class="btn-row"><button class="btn" id="runBtn">Run</button></div>
    </div>
  `;

  if (wantsSources) {
    renderSourceChips();
    document.getElementById("pickBtn").addEventListener("click", () => {
      const card = document.getElementById("pickerCard");
      card.classList.toggle("hidden");
      if (!card.classList.contains("hidden")) {
        renderGallery(card, project, {
          onPick: () => { card.classList.add("hidden"); renderSourceChips(); renderSegmentSection(project, action); },
        });
      }
    });
    document.getElementById("clearSrcBtn").addEventListener("click", () => {
      state.selection = [];
      renderSourceChips();
      renderSegmentSection(project, action);
    });
  }

  const form = document.getElementById("paramsForm");
  const params = action.params || {};
  const commonEntries = Object.entries(params).filter(([, spec]) => !spec.advanced);
  const advancedEntries = Object.entries(params).filter(([, spec]) => spec.advanced);
  for (const [name, spec] of commonEntries) {
    form.appendChild(paramField(name, spec));
  }
  if (advancedEntries.length) {
    const details = el(`<details class="advanced"><summary>Advanced</summary></details>`);
    for (const [name, spec] of advancedEntries) {
      details.appendChild(paramField(name, spec));
    }
    form.appendChild(details);
  }
  const flags = action.flags || {};
  if (Object.keys(flags).length) {
    const flagWrap = el(`<div></div>`);
    for (const [flag, desc] of Object.entries(flags)) {
      const row = el(`<label class="checkbox-row"><input type="checkbox" data-flag="${flag}"><span>${desc || flag}</span></label>`);
      flagWrap.appendChild(row);
    }
    form.appendChild(flagWrap);
  }

  renderSegmentSection(project, action);

  document.getElementById("runBtn").addEventListener("click", async (e) => {
    e.preventDefault();
    const paramValues = {};
    for (const [name, spec] of Object.entries(params)) {
      const inputEl = form.querySelector(`[name="${name}"]`);
      if (!inputEl) continue;
      let v = inputEl.value;
      if (v === "" || v == null) continue;   // unset optional param → omit entirely
      if (spec.type === "float") { v = parseFloat(v); if (Number.isNaN(v)) continue; }
      else if (spec.type === "int") { v = parseInt(v, 10); if (Number.isNaN(v)) continue; }
      paramValues[name] = v;
    }
    const chosenFlags = Array.from(form.querySelectorAll("[data-flag]"))
      .filter((c) => c.checked)
      .map((c) => c.dataset.flag);
    const sources = wantsSources ? state.selection.map((s) => s.path) : [];
    if (wantsSources && !sources.length && !action.supports_segment) {
      toast("Pick at least one source item");
      return;
    }
    const hasSegment = action.supports_segment && sources.length === 1
      && segment.start != null && segment.end != null && segment.end > segment.start;
    const payload = { sources, params: paramValues, flags: chosenFlags };
    if (hasSegment) payload.segment = { start: segment.start, end: segment.end };
    try {
      const res = await api(`/api/p/${project.name}/action/${curAction}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast(`Job started: ${res.job}`);
      state.selection = [];
      setHash({ tab: "jobs", job: res.job });
    } catch (err) { /* toasted */ }
  });
}

function updateRunBtnLabel() {
  const btn = document.getElementById("runBtn");
  if (!btn) return;
  if (segment.start != null && segment.end != null && segment.end > segment.start) {
    const dur = Math.round(segment.end - segment.start);
    btn.textContent = `Run on segment (${dur}s)`;
  } else {
    btn.textContent = "Run";
  }
}

function renderSegmentSection(project, action) {
  const card = document.getElementById("segmentCard");
  if (!card) return;
  card.innerHTML = "";
  segment = { start: null, end: null };
  segmentViewer = null;
  if (!action.supports_segment) return;
  const videoSources = state.selection.filter((s) => s.kind === "video" || VIDEO_EXT.test(s.path));
  if (videoSources.length !== 1) return;
  const source = videoSources[0];

  card.classList.add("card");
  card.innerHTML = `
    <h3>Test on a segment</h3>
    <div id="segVideoWrap"></div>
    <div class="segment-row">
      <div class="segment-field">
        <label>Start</label>
        <input type="text" id="segStart" placeholder="mm:ss">
        <button type="button" class="btn secondary" id="segSetStart">Set start</button>
      </div>
      <div class="segment-field">
        <label>End</label>
        <input type="text" id="segEnd" placeholder="mm:ss">
        <button type="button" class="btn secondary" id="segSetEnd">Set end</button>
      </div>
    </div>
    <a href="#" class="hint" id="segClear">Clear</a>
  `;
  const videoWrap = document.getElementById("segVideoWrap");
  segmentViewer = attachVideo(videoWrap, source.path, { autoplay: false });

  const startInput = document.getElementById("segStart");
  const endInput = document.getElementById("segEnd");

  function syncFromInputs() {
    segment.start = parseTimeStr(startInput.value);
    segment.end = parseTimeStr(endInput.value);
    updateRunBtnLabel();
  }
  startInput.addEventListener("input", syncFromInputs);
  endInput.addEventListener("input", syncFromInputs);

  document.getElementById("segSetStart").addEventListener("click", () => {
    const v = segmentViewer.getVideo();
    if (!v) return;
    startInput.value = fmtTimeStr(v.currentTime);
    syncFromInputs();
  });
  document.getElementById("segSetEnd").addEventListener("click", () => {
    const v = segmentViewer.getVideo();
    if (!v) return;
    endInput.value = fmtTimeStr(v.currentTime);
    syncFromInputs();
  });
  document.getElementById("segClear").addEventListener("click", (e) => {
    e.preventDefault();
    startInput.value = "";
    endInput.value = "";
    syncFromInputs();
  });
  updateRunBtnLabel();
}

function renderSourceChips() {
  const row = document.getElementById("srcChips");
  if (!row) return;
  if (!state.selection.length) {
    row.innerHTML = `<span class="muted">No sources selected</span>`;
    return;
  }
  row.innerHTML = "";
  state.selection.forEach((s, i) => {
    const chip = el(`<span class="chip">${s.name} ✕</span>`);
    chip.addEventListener("click", () => {
      state.selection.splice(i, 1);
      renderSourceChips();
    });
    row.appendChild(chip);
  });
}

function paramField(name, spec) {
  const label = spec.description || name;
  if (spec.type === "choice") {
    const opts = (spec.options || []).map((o) => `<option value="${o}" ${o === spec.default ? "selected" : ""}>${o}</option>`).join("");
    return el(`<div class="field"><label>${label}</label><select name="${name}">${opts}</select></div>`);
  }
  if (spec.type === "float" || spec.type === "int") {
    const step = spec.type === "float" ? "0.05" : "1";
    const min = spec.min != null ? `min="${spec.min}"` : "";
    const max = spec.max != null ? `max="${spec.max}"` : "";
    const val = spec.default != null ? spec.default : "";
    return el(`<div class="field"><label>${label}</label><input type="number" step="${step}" ${min} ${max} name="${name}" value="${val}">
      ${spec.min != null || spec.max != null ? `<div class="hint">range ${spec.min ?? ""}–${spec.max ?? ""}</div>` : ""}
    </div>`);
  }
  return el(`<div class="field"><label>${label}</label><input type="text" name="${name}" value="${spec.default ?? ""}"></div>`);
}

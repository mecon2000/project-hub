import { state, api, el, toast, setHash } from "./app.js";
import { renderGallery } from "./gallery.js";

let curAction = null;

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

function renderBody(project) {
  const action = project.actions[curAction];
  const body = document.getElementById("actionBody");
  if (!action) { body.innerHTML = `<div class="empty">No actions available.</div>`; return; }

  const estBits = [];
  if (action.wall_time_estimate_sec) estBits.push(`~${Math.round(action.wall_time_estimate_sec / 60)} min`);
  if (action.cost_estimate_usd) estBits.push(`~$${action.cost_estimate_usd}`);

  body.innerHTML = `
    <div class="card">
      <h3>Sources</h3>
      <div class="chip-row" id="srcChips"></div>
      <div class="btn-row">
        <button class="btn secondary" id="pickBtn">Pick from gallery</button>
        <button class="btn secondary" id="clearSrcBtn">Clear</button>
      </div>
    </div>
    <div class="card" id="pickerCard"></div>
    <div class="card">
      <h3>Parameters</h3>
      <form id="paramsForm"></form>
      ${estBits.length ? `<div class="muted">Estimate: ${estBits.join(" · ")}</div>` : ""}
      <div class="btn-row"><button class="btn" id="runBtn">Run</button></div>
    </div>
  `;

  renderSourceChips();
  document.getElementById("pickBtn").addEventListener("click", () => {
    const card = document.getElementById("pickerCard");
    card.classList.toggle("hidden");
    if (!card.classList.contains("hidden")) {
      renderGallery(card, project, {
        onPick: () => { card.classList.add("hidden"); renderSourceChips(); },
      });
    }
  });
  document.getElementById("clearSrcBtn").addEventListener("click", () => {
    state.selection = [];
    renderSourceChips();
  });

  const form = document.getElementById("paramsForm");
  const params = action.params || {};
  for (const [name, spec] of Object.entries(params)) {
    form.appendChild(paramField(name, spec));
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

  document.getElementById("runBtn").addEventListener("click", async (e) => {
    e.preventDefault();
    const paramValues = {};
    for (const [name, spec] of Object.entries(params)) {
      const inputEl = form.querySelector(`[name="${name}"]`);
      if (!inputEl) continue;
      let v = inputEl.value;
      if (spec.type === "float") v = parseFloat(v);
      else if (spec.type === "int") v = parseInt(v, 10);
      paramValues[name] = v;
    }
    const chosenFlags = Array.from(form.querySelectorAll("[data-flag]"))
      .filter((c) => c.checked)
      .map((c) => c.dataset.flag);
    const sources = state.selection.map((s) => s.path);
    if (!sources.length && !action.supports_segment) {
      toast("Pick at least one source item");
      return;
    }
    try {
      const res = await api(`/api/p/${project.name}/action/${curAction}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources, params: paramValues, flags: chosenFlags }),
      });
      toast(`Job started: ${res.job}`);
      state.selection = [];
      setHash({ tab: "jobs", job: res.job });
    } catch (err) { /* toasted */ }
  });
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

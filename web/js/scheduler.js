import { api, el, toast } from "./app.js";

let newForm = { project: null, action: null };

export async function renderSchedules(view, projects) {
  view.innerHTML = `
    <h2>Schedules</h2>
    <div class="card" id="schedList"></div>
    <div class="card">
      <h3>New schedule</h3>
      <form id="newSchedForm"></form>
    </div>
  `;
  await refresh(view, projects);
  buildNewForm(projects);
}

async function refresh(view, projects) {
  let scheds;
  try { scheds = await api("/api/schedules"); }
  catch (e) { return; }
  const list = document.getElementById("schedList");
  if (!scheds.length) { list.innerHTML = `<div class="empty">No schedules yet.</div>`; return; }
  list.innerHTML = "";
  for (const s of scheds) {
    const row = el(`<div class="sched-row">
      <div class="job-meta">
        <div>${s.label || s.id} <span class="muted">(${s.project} · ${s.action})</span></div>
        <div class="sub">cron: ${s.cron} · next: ${s.next_run || "?"}</div>
      </div>
      <label class="checkbox-row"><input type="checkbox" ${s.enabled ? "checked" : ""}></label>
      <button class="btn danger" style="padding:8px 12px">Del</button>
    </div>`);
    row.querySelector('input[type=checkbox]').addEventListener("change", async (e) => {
      try {
        await api("/api/schedules", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...s, enabled: e.target.checked }),
        });
        toast("Updated");
      } catch (err) { e.target.checked = !e.target.checked; }
    });
    row.querySelector(".btn.danger").addEventListener("click", async () => {
      if (!confirm(`Delete schedule "${s.label || s.id}"?`)) return;
      try {
        await api(`/api/schedules/${s.id}`, { method: "DELETE" });
        refresh(view, projects);
      } catch (e) { /* toasted */ }
    });
    list.appendChild(row);
  }
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
    return el(`<div class="field"><label>${label}</label><input type="number" step="${step}" ${min} ${max} name="${name}" value="${val}"></div>`);
  }
  return el(`<div class="field"><label>${label}</label><input type="text" name="${name}" value="${spec.default ?? ""}"></div>`);
}

function buildNewForm(projects) {
  const form = document.getElementById("newSchedForm");
  const projNames = projects.map((p) => p.name);
  newForm.project = newForm.project && projNames.includes(newForm.project) ? newForm.project : projNames[0];

  function actionsFor(pname) {
    const p = projects.find((pp) => pp.name === pname);
    return p ? Object.keys(p.actions || {}) : [];
  }
  newForm.action = newForm.action && actionsFor(newForm.project).includes(newForm.action)
    ? newForm.action : actionsFor(newForm.project)[0];

  form.innerHTML = `
    <div class="field"><label>Label</label><input type="text" name="label" placeholder="nightly-relight"></div>
    <div class="field">
      <label>Cron</label>
      <input type="text" name="cron" placeholder="0 8 * * *">
      <div class="hint">m h dom mon dow, e.g. 0 8 * * *</div>
    </div>
    <div class="field">
      <label>Project</label>
      <select name="project">${projNames.map((n) => `<option value="${n}" ${n === newForm.project ? "selected" : ""}>${n}</option>`).join("")}</select>
    </div>
    <div class="field">
      <label>Action</label>
      <select name="action">${actionsFor(newForm.project).map((a) => `<option value="${a}" ${a === newForm.action ? "selected" : ""}>${a}</option>`).join("")}</select>
    </div>
    <div id="newParams"></div>
    <div class="field"><label>Source glob</label><input type="text" name="source_glob" placeholder="outputs/*.jpg"></div>
    <div class="btn-row"><button class="btn" type="submit">Save schedule</button></div>
  `;

  const projSel = form.querySelector('[name="project"]');
  const actSel = form.querySelector('[name="action"]');
  const paramsWrap = document.getElementById("newParams");

  function renderParams() {
    paramsWrap.innerHTML = "";
    const p = projects.find((pp) => pp.name === projSel.value);
    const action = p && p.actions[actSel.value];
    if (!action) return;
    for (const [name, spec] of Object.entries(action.params || {})) {
      paramsWrap.appendChild(paramField(name, spec));
    }
  }
  projSel.addEventListener("change", () => {
    newForm.project = projSel.value;
    const opts = actionsFor(projSel.value);
    actSel.innerHTML = opts.map((a) => `<option value="${a}">${a}</option>`).join("");
    renderParams();
  });
  actSel.addEventListener("change", renderParams);
  renderParams();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const p = projects.find((pp) => pp.name === projSel.value);
    const action = p && p.actions[actSel.value];
    const params = {};
    for (const name of Object.keys(action?.params || {})) {
      const inputEl = form.querySelector(`[name="${name}"]`);
      if (inputEl) params[name] = inputEl.value;
    }
    const body = {
      label: fd.get("label"),
      cron: fd.get("cron"),
      project: projSel.value,
      action: actSel.value,
      params,
      flags: [],
      source_glob: fd.get("source_glob"),
      enabled: true,
    };
    try {
      await api("/api/schedules", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      toast("Schedule saved");
      form.reset();
      renderSchedules(document.getElementById("view"), projects);
    } catch (err) { /* toasted */ }
  });
}

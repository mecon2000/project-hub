import { api, el, toast } from "./app.js";

let views = [];
let curView = null;

export async function renderDb(view, project) {
  if (!project) {
    view.innerHTML = `<div class="empty">No project selected.</div>`;
    return;
  }
  view.innerHTML = `<h2>DB</h2><div id="dbBody"><div class="muted">Loading…</div></div>`;
  const body = document.getElementById("dbBody");
  try {
    views = await api(`/api/p/${project.name}/db`);
  } catch (e) {
    body.innerHTML = `<div class="empty">Failed to load DB views.</div>`;
    return;
  }
  if (!views.length) {
    body.innerHTML = `<div class="empty">No DB views for this project.</div>`;
    return;
  }
  if (!curView || !views.find((v) => v.name === curView)) curView = views[0].name;
  renderBody(project, body);
}

function renderBody(project, body) {
  const v = views.find((x) => x.name === curView);
  body.innerHTML = `
    ${views.length > 1 ? `<div class="chip-row" id="dbChips"></div>` : ""}
    <div class="field" id="cannedField"></div>
    <div class="field" id="textField">
      <label>Search text</label>
      <input type="text" id="dbText" placeholder="search text…">
    </div>
    <div class="btn-row"><button class="btn" id="dbRunBtn">Run</button></div>
    ${v.allow_raw_sql ? `
      <details class="advanced">
        <summary>Raw SQL</summary>
        <div class="field">
          <textarea id="dbSql" rows="4" style="width:100%; padding:12px; border-radius:8px; border:1px solid var(--border); background:#191919; color:var(--text); font-family:ui-monospace,Menlo,monospace;"></textarea>
        </div>
        <div class="btn-row"><button class="btn secondary" id="dbSqlBtn">Run SQL</button></div>
      </details>
    ` : ""}
    <div id="dbError"></div>
    <div id="dbResults"></div>
  `;

  if (views.length > 1) {
    const chipRow = document.getElementById("dbChips");
    views.forEach((vv) => {
      const c = el(`<button class="chip ${vv.name === curView ? "active" : ""}">${vv.label || vv.name}</button>`);
      c.addEventListener("click", () => {
        curView = vv.name;
        renderBody(project, body);
      });
      chipRow.appendChild(c);
    });
  }

  const cannedField = document.getElementById("cannedField");
  const textInput = document.getElementById("dbText");
  const textField = document.getElementById("textField");
  let cannedSelect = null;

  if (v.canned && v.canned.length) {
    cannedField.innerHTML = `<label>Query</label><select id="dbCanned"></select>`;
    cannedSelect = document.getElementById("dbCanned");
    const opts = [`<option value="">— none —</option>`].concat(
      v.canned.map((c) => `<option value="${c.name}">${c.label || c.name}</option>`)
    );
    cannedSelect.innerHTML = opts.join("");
    const syncText = () => {
      const sel = v.canned.find((c) => c.name === cannedSelect.value);
      const needsText = sel && sel.needs_text;
      textField.classList.toggle("hidden", !(needsText || (!cannedSelect.value && v.free_text)));
    };
    cannedSelect.addEventListener("change", syncText);
    syncText();
  } else {
    cannedField.classList.add("hidden");
    textField.classList.toggle("hidden", !v.free_text);
  }

  document.getElementById("dbRunBtn").addEventListener("click", () => {
    const body = {};
    const cannedVal = cannedSelect ? cannedSelect.value : "";
    if (cannedVal) {
      body.query = cannedVal;
      if (textInput.value) body.q = textInput.value;
    } else if (textInput.value) {
      body.q = textInput.value;
    } else {
      toast("Enter search text or pick a query");
      return;
    }
    runQuery(project, body);
  });

  const sqlBtn = document.getElementById("dbSqlBtn");
  if (sqlBtn) {
    sqlBtn.addEventListener("click", () => {
      const sql = document.getElementById("dbSql").value.trim();
      if (!sql) { toast("Enter SQL"); return; }
      runQuery(project, { sql });
    });
  }
}

async function runQuery(project, body) {
  const errBox = document.getElementById("dbError");
  const resBox = document.getElementById("dbResults");
  errBox.innerHTML = "";
  resBox.innerHTML = `<div class="muted">Running…</div>`;
  try {
    const r = await api(`/api/p/${project.name}/db/${curView}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.error) {
      errBox.innerHTML = `<div class="empty">${r.error}</div>`;
      resBox.innerHTML = "";
      return;
    }
    renderTable(resBox, r);
  } catch (e) {
    resBox.innerHTML = "";
    errBox.innerHTML = `<div class="empty">Query failed.</div>`;
  }
}

function renderTable(resBox, r) {
  const cols = r.columns || [];
  const rows = r.rows || [];
  const thead = `<thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${rows.map((row) =>
    `<tr>${row.map((v) => `<td>${v == null ? "" : String(v)}</td>`).join("")}</tr>`
  ).join("")}</tbody>`;
  resBox.innerHTML = `
    <div class="muted db-count">${rows.length} row(s)${r.truncated ? " (truncated at 500)" : ""}</div>
    <div class="db-table-wrap"><table class="db-table">${thead}${tbody}</table></div>
  `;
}

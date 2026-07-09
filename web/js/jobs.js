import { api, el, relTime, setHash } from "./app.js";

let refreshTimer = null;
let curProjectName = null;
let curES = null;

export async function renderJobs(view, project) {
  curProjectName = project ? project.name : null;
  view.innerHTML = `
    <h2>Jobs</h2>
    <div class="card" id="jobsList"></div>
    <div id="jobDetail"></div>
  `;
  await refreshList();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.getElementById("jobsList")) refreshList();
    else clearInterval(refreshTimer);
  }, 5000);
}

async function refreshList() {
  let jobs;
  try {
    jobs = await api(`/api/jobs${curProjectName ? `?project=${encodeURIComponent(curProjectName)}` : ""}`);
  } catch (e) { return; }
  jobs.sort((a, b) => (b.started || "").localeCompare(a.started || ""));
  const list = document.getElementById("jobsList");
  if (!list) return;
  if (!jobs.length) { list.innerHTML = `<div class="empty">No jobs yet.</div>`; return; }
  list.innerHTML = "";
  for (const j of jobs) {
    const icon = j.status === "running" ? "⟳" : j.status === "done" ? "✓" : "✗";
    const cls = j.status === "running" ? "status-running" : j.status === "done" ? "status-done" : "status-failed";
    const dur = j.started && j.finished
      ? `${Math.max(0, Math.round((new Date(j.finished) - new Date(j.started)) / 1000))}s`
      : "";
    const row = el(`<div class="job-row">
      <span class="status-icon ${cls}">${icon}</span>
      <div class="job-meta">
        <div>${j.project} · ${j.action}</div>
        <div class="sub">${relTime(j.started)} ${dur ? "· " + dur : ""}</div>
      </div>
    </div>`);
    row.addEventListener("click", () => setHash({ tab: "jobs", job: j.id }));
    list.appendChild(row);
  }
}

export async function openJobDetail(view, jobId) {
  const detail = document.getElementById("jobDetail") || view;
  detail.innerHTML = `<div class="card">Loading job…</div>`;
  let job;
  try { job = await api(`/api/jobs/${jobId}`); }
  catch (e) { detail.innerHTML = `<div class="card">Job not found.</div>`; return; }

  detail.innerHTML = `
    <div class="card">
      <h3>${job.project} · ${job.action} <span class="muted">(${job.status})</span></h3>
      <details><summary>argv</summary><div class="log-box">${(job.argv || []).join(" ")}</div></details>
      <div class="muted" style="margin-top:8px">started: ${relTime(job.started)} ${job.finished ? "· finished: " + relTime(job.finished) : ""}</div>
      <h3 style="margin-top:14px">Log</h3>
      <div class="log-box" id="logBox"></div>
      <div id="outputsWrap"></div>
    </div>
  `;

  const logBox = document.getElementById("logBox");
  if (curES) { curES.close(); curES = null; }

  if (job.status === "running") {
    try {
      const es = new EventSource(`/api/jobs/${jobId}/log/stream`);
      curES = es;
      es.onmessage = (ev) => {
        logBox.textContent += ev.data + "\n";
        logBox.scrollTop = logBox.scrollHeight;
      };
      es.addEventListener("done", () => {
        es.close();
        curES = null;
        openJobDetail(view, jobId);
      });
      es.onerror = () => {
        es.close();
        curES = null;
        pollLog(jobId, logBox);
      };
    } catch (e) {
      pollLog(jobId, logBox);
    }
  } else {
    try {
      logBox.textContent = await api(`/api/jobs/${jobId}/log`);
    } catch (e) { logBox.textContent = "(no log)"; }
    renderOutputs(job);
  }
}

async function pollLog(jobId, logBox) {
  const poll = async () => {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      logBox.textContent = await api(`/api/jobs/${jobId}/log`);
      logBox.scrollTop = logBox.scrollHeight;
      if (job.status === "running") setTimeout(poll, 3000);
      else renderOutputs(job);
    } catch (e) { /* toasted */ }
  };
  poll();
}

function renderOutputs(job) {
  const wrap = document.getElementById("outputsWrap");
  if (!wrap || !job.outputs || !job.outputs.length) return;
  wrap.innerHTML = `<h3 style="margin-top:14px">Outputs</h3><div class="gallery-grid" id="outGrid"></div>`;
  const grid = document.getElementById("outGrid");
  for (const path of job.outputs) {
    const thumb = el(`<div class="thumb"><img loading="lazy" src="/thumb?path=${encodeURIComponent(path)}"></div>`);
    thumb.addEventListener("click", () => {
      window.open(`/file?path=${encodeURIComponent(path)}`, "_blank");
    });
    grid.appendChild(thumb);
  }
}

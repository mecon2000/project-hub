import { api, el, relTime, setHash } from "./app.js";
import { attachVideo } from "./viewer.js";
import { openCompare } from "./compare.js";

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|avi|m4v)$/i;

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
  jobs.sort((a, b) => (b.started || 0) - (a.started || 0));
  const list = document.getElementById("jobsList");
  if (!list) return;
  if (!jobs.length) { list.innerHTML = `<div class="empty">No jobs yet.</div>`; return; }
  list.innerHTML = "";
  for (const j of jobs) {
    const icon = j.status === "running" ? "⟳" : j.status === "done" ? "✓" : "✗";
    const cls = j.status === "running" ? "status-running" : j.status === "done" ? "status-done" : "status-failed";
    const dur = j.started && j.finished
      ? `${Math.max(0, Math.round(j.finished - j.started))}s`
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

  const source0 = (job.sources || [])[0];
  const firstVideoOutput = (job.outputs || []).find((p) => VIDEO_EXT.test(p));
  const canCompare = source0 && VIDEO_EXT.test(source0) && firstVideoOutput;

  detail.innerHTML = `
    <div class="card">
      <h3>${job.project} · ${job.action} <span class="muted">(${job.status})</span></h3>
      <details><summary>argv</summary><div class="log-box">${(job.argv || []).join(" ")}</div></details>
      <div class="muted" style="margin-top:8px">started: ${relTime(job.started)} ${job.finished ? "· finished: " + relTime(job.finished) : ""}</div>
      ${canCompare ? '<div class="btn-row"><button class="btn secondary" id="jobCompareBtn">Compare source ↔ output</button></div>' : ""}
      <h3 style="margin-top:14px">Log</h3>
      <div class="log-box" id="logBox"></div>
      <div id="outputsWrap"></div>
    </div>
  `;

  if (canCompare) {
    document.getElementById("jobCompareBtn").addEventListener("click", () => {
      openCompare(source0, firstVideoOutput, "source", "censored");
    });
  }

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
    const isVideo = VIDEO_EXT.test(path);
    const thumb = el(`<div class="thumb">
      <img loading="lazy" src="/thumb?path=${encodeURIComponent(path)}">
      ${isVideo ? '<span class="badge">▶</span>' : ""}
    </div>`);
    thumb.addEventListener("click", () => openMediaOverlay(path, isVideo));
    grid.appendChild(thumb);
  }
}

function openMediaOverlay(path, isVideo) {
  const overlay = el(`<div class="compare-overlay media-overlay">
    <div class="compare-top">
      <div class="muted"></div>
      <button class="lightbox-close" id="movClose">✕</button>
    </div>
    <div class="media-overlay-body" id="movBody"></div>
  </div>`);
  document.body.appendChild(overlay);
  const bodyEl = overlay.querySelector("#movBody");
  let viewer = null;
  if (isVideo) {
    viewer = attachVideo(bodyEl, path, { autoplay: true });
  } else {
    bodyEl.appendChild(el(`<img src="/file?path=${encodeURIComponent(path)}">`));
  }
  function close() {
    if (viewer && viewer.el._stop) viewer.el._stop();
    document.removeEventListener("keydown", keyHandler);
    overlay.remove();
  }
  function keyHandler(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", keyHandler);
  overlay.querySelector("#movClose").addEventListener("click", close);
}

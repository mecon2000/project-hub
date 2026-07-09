import { renderGallery } from "./gallery.js";
import { renderActions } from "./actions.js";
import { renderJobs, openJobDetail } from "./jobs.js";
import { renderSchedules } from "./scheduler.js";

export const state = {
  projects: [],
  project: null,
  tab: "home",
  area: null,
  job: null,
  selection: [], // {name, path, kind} chosen as action sources
  pickMode: false,
};

const view = document.getElementById("view");
const toastEl = document.getElementById("toast");
let toastTimer = null;

export function toast(msg, ms = 3000) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), ms);
}

export async function api(path, opts) {
  try {
    const res = await fetch(path, opts);
    if (!res.ok) {
      let msg = res.statusText;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
      toast(`Error: ${msg}`);
      throw new Error(msg);
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return await res.json();
    return await res.text();
  } catch (e) {
    if (!/^Error:/.test(String(e.message))) toast(`Network error: ${e.message}`);
    throw e;
  }
}

export function humanSize(n) {
  if (n == null) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function relTime(ts) {
  if (!ts) return "";
  const t = typeof ts === "number" ? ts * (ts < 2e10 ? 1000 : 1) : new Date(ts).getTime();
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function parseHash() {
  const h = location.hash.replace(/^#/, "");
  const parts = new URLSearchParams(h.replace(/&/g, "&"));
  return {
    p: parts.get("p"),
    tab: parts.get("tab") || "home",
    area: parts.get("area"),
    job: parts.get("job"),
  };
}

export function setHash(patch) {
  const cur = parseHash();
  const next = { ...cur, ...patch };
  const params = new URLSearchParams();
  if (next.p) params.set("p", next.p);
  if (next.tab) params.set("tab", next.tab);
  if (next.area) params.set("area", next.area);
  if (next.job) params.set("job", next.job);
  location.hash = params.toString();
}

function currentProject() {
  return state.projects.find((p) => p.name === state.project) || null;
}

async function loadProjects() {
  state.projects = await api("/api/projects");
  const sel = document.getElementById("projectSelect");
  sel.innerHTML = state.projects
    .map((p) => `<option value="${p.name}">${p.label || p.name}</option>`)
    .join("");
  sel.onchange = () => {
    state.project = sel.value;
    state.area = null;
    setHash({ p: sel.value, area: null });
  };
}

function setActiveTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
}

async function renderHome() {
  view.innerHTML = `<h2>Projects</h2><div class="card-grid" id="homeGrid"></div>`;
  const grid = document.getElementById("homeGrid");
  if (!state.projects.length) {
    grid.innerHTML = `<div class="empty">No projects found.</div>`;
    return;
  }
  for (const p of state.projects) {
    const areaNames = Object.keys(p.areas || {});
    const card = el(`<div class="card">
      <h3>${p.label || p.name}</h3>
      <div class="muted">${areaNames.length} area(s) · ${Object.keys(p.actions || {}).length} action(s)</div>
      <div class="chip-row" data-areas></div>
    </div>`);
    card.addEventListener("click", () => {
      state.project = p.name;
      state.tab = "gallery";
      document.getElementById("projectSelect").value = p.name;
      setHash({ p: p.name, tab: "gallery" });
    });
    grid.appendChild(card);
    const chipRow = card.querySelector("[data-areas]");
    for (const a of areaNames) {
      const chip = el(`<span class="chip">${a}…</span>`);
      chipRow.appendChild(chip);
      api(`/api/p/${p.name}/media?area=${encodeURIComponent(a)}&offset=0&limit=1`)
        .then((r) => { chip.textContent = `${a} (${r.total})`; })
        .catch(() => { chip.textContent = a; });
    }
  }
}

function renderWiring() {
  api("/api/wiring").then((w) => {
    const svc = Object.entries(w.services || {})
      .map(([name, st]) => {
        const ok = /run|active|ok/i.test(String(st));
        return `<div><span class="dot ${ok ? "green" : "red"}"></span>${name}: ${st}</div>`;
      })
      .join("");
    const projects = Object.entries(w.projects || {})
      .map(([name, path]) => `<div>${name} → <span class="muted">${path}</span></div>`)
      .join("");
    const howto = (w.howto || []).map((s) => `<li>${s}</li>`).join("");
    view.innerHTML = `
      <h2>Wiring</h2>
      <div class="card">
        <h3>Hub</h3>
        <div>URL: <a href="${w.hub_url}" target="_blank">${w.hub_url}</a> (port ${w.hub_port})</div>
        <div>ntfy local: <a href="${w.ntfy_url_local}" target="_blank">${w.ntfy_url_local || ""}</a></div>
        <div>ntfy public: <a href="${w.ntfy_url_public}" target="_blank">${w.ntfy_url_public || ""}</a></div>
        <div>topic: ${w.ntfy_topic || ""}</div>
      </div>
      <div class="card"><h3>Services</h3>${svc || '<div class="muted">none</div>'}</div>
      <div class="card"><h3>Projects → manifest</h3>${projects || '<div class="muted">none</div>'}</div>
      <div class="card"><h3>How-to</h3><ul>${howto}</ul></div>
    `;
  });
}

async function route() {
  const h = parseHash();
  if (h.p) state.project = h.p;
  if (!state.project && state.projects.length) state.project = state.projects[0].name;
  state.tab = h.job ? "jobs" : h.tab;
  state.area = h.area;
  state.job = h.job;

  const sel = document.getElementById("projectSelect");
  if (sel && state.project) sel.value = state.project;
  setActiveTab(state.tab);

  if (state.tab === "home") return renderHome();
  if (state.tab === "gallery") return renderGallery(view, currentProject());
  if (state.tab === "actions") return renderActions(view, currentProject());
  if (state.tab === "jobs") {
    await renderJobs(view, currentProject());
    if (state.job) openJobDetail(view, state.job);
    return;
  }
  if (state.tab === "schedules") return renderSchedules(view, state.projects);
  if (state.tab === "wiring") return renderWiring();
}

document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  setHash({ tab: btn.dataset.tab, job: btn.dataset.tab === "jobs" ? state.job : null });
});

window.addEventListener("hashchange", route);

(async function init() {
  try {
    await loadProjects();
  } catch (e) { /* toast already shown */ }
  route();
})();

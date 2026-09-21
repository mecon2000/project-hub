import { api, el, toast } from "./app.js";

// Review bar for areas whose manifest sets `review:` (true, or {contract: "..."}).
// Pass/fail/unsure map onto the hub's good/bad/unsure votes; the note and an optional
// marked spot travel with the vote and land in the verdicts history.
const LABELS = [["good", "✓ Pass", "ok"], ["bad", "✗ Fail", "danger"], ["unsure", "? Unsure", "secondary"]];

export function reviewEnabled(project, area) {
  return !!(project.areas && project.areas[area] && project.areas[area].review);
}

export function attachReview(lb, project, item, area, onVoted) {
  const cfg = project.areas[area].review;
  const sc = item.sidecar || {};
  let mark = sc.vote_mark || null;
  let arming = false;
  const bar = el(`<div class="review-bar">
    ${cfg.contract ? `<div class="review-contract muted">${cfg.contract}</div>` : ""}
    <div class="review-btns">
      ${LABELS.map(([v, label, cls]) =>
        `<button class="btn ${cls} ${sc.vote === v ? "active" : ""}" data-v="${v}">${label}</button>`).join("")}
      <button class="btn secondary" id="rvMark">📍 Mark spot</button>
    </div>
    <textarea id="rvNote" rows="2" placeholder="Note (what's wrong, where)">${sc.vote_note || ""}</textarea>
  </div>`);
  lb.querySelector(".lightbox-actions").before(bar);

  const media = lb.querySelector(".lightbox-media");
  const img = lb.querySelector("#lbImg");
  const dot = el(`<div class="review-dot hidden"></div>`);
  media.appendChild(dot);
  const place = () => {
    if (!img || !mark) { dot.classList.add("hidden"); return; }
    const r = img.getBoundingClientRect(), m = media.getBoundingClientRect();
    dot.style.left = `${r.left - m.left + mark.x * r.width}px`;
    dot.style.top = `${r.top - m.top + mark.y * r.height}px`;
    dot.classList.remove("hidden");
  };
  if (img) { img.complete ? place() : img.addEventListener("load", place); }

  const markBtn = bar.querySelector("#rvMark");
  if (!img) markBtn.disabled = true;
  markBtn.addEventListener("click", () => {
    if (mark && !arming) { mark = null; place(); markBtn.textContent = "📍 Mark spot"; return; }
    arming = !arming;
    markBtn.textContent = arming ? "Tap the image…" : "📍 Mark spot";
  });
  if (mark) markBtn.textContent = "📍 Clear mark";
  img && img.addEventListener("click", (e) => {
    if (!arming) return;
    e.stopPropagation();
    const r = img.getBoundingClientRect();
    mark = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    arming = false;
    markBtn.textContent = "📍 Clear mark";
    place();
  }, true);

  bar.querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", async () => {
    const vote = b.dataset.v;
    const note = bar.querySelector("#rvNote").value.trim();
    try {
      await api(`/api/p/${project.name}/vote`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: item.path, vote, note, mark, area }),
      });
      item.sidecar = Object.assign(item.sidecar || {}, { vote, vote_note: note, vote_mark: mark });
      toast(`${b.textContent} saved`);
      onVoted && onVoted();
    } catch (e) { /* toasted */ }
  }));
}

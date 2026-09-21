import { api, el, toast } from "./app.js";

// Best-of-N for areas with manifest `pick: true` + `group_by: dir`: the group's variants
// show as a grid instead of a slideshow. Tap to select, tap again to view large,
// "★ Pick" records the winner (and the rejected siblings) in the hub's picks history.
export function pickEnabled(project, area, item) {
  const a = project.areas && project.areas[area];
  return !!(a && a.pick && item.kind === "group" && (item.members || []).length);
}

export function attachPick(lb, project, item, area, onPicked) {
  const media = lb.querySelector(".lightbox-media");
  media.querySelector("#lbImg")?.remove();
  const st = lb.querySelector("#lbSlideState");
  if (st) st.textContent = "pick the best";
  let sel = item.members.find((m) => item.picked === m) || null;
  const grid = el(`<div class="pick-grid n${Math.min(item.members.length, 9)}"></div>`);
  const btn = el(`<button class="btn" id="pkGo" disabled>★ Pick</button>`);
  const big = el(`<div class="pick-big hidden"><img></div>`);
  for (const m of item.members) {
    const cell = el(`<div class="pick-cell"><img draggable="false" src="/file?path=${encodeURIComponent(m)}"></div>`);
    cell.addEventListener("click", () => {
      if (sel === m) { big.querySelector("img").src = cell.querySelector("img").src; big.classList.remove("hidden"); return; }
      sel = m;
      grid.querySelectorAll(".pick-cell").forEach((c) => c.classList.remove("sel"));
      cell.classList.add("sel");
      btn.disabled = false;
    });
    grid.appendChild(cell);
  }
  big.addEventListener("click", () => big.classList.add("hidden"));
  media.append(grid, big);
  const row = el(`<div class="pick-row"><span class="muted">tap = select · tap again = view large</span></div>`);
  row.prepend(btn);
  lb.querySelector(".lightbox-actions").before(row);
  btn.addEventListener("click", async () => {
    if (!sel) return;
    try {
      await api(`/api/p/${project.name}/pick`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group: item.path, chosen: sel, members: item.members, area }),
      });
      item.picked = sel;
      toast("★ Picked");
      onPicked && onPicked();
    } catch (e) { /* toasted */ }
  });
}

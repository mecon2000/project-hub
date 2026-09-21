import { api, el } from "./app.js";

// Areas with manifest `compare_with: <area>`: hold the image (mouse or finger) to see
// the same-named file from the other area in exactly the same place; release to go back.
export async function attachHoldReveal(lb, project, item, area) {
  const cfg = project.areas && project.areas[area];
  const img = lb.querySelector("#lbImg");
  if (!cfg || !cfg.compare_with || !img) return;
  let r;
  try {
    r = await api(`/api/p/${project.name}/counterpart?area=${encodeURIComponent(area)}&path=${encodeURIComponent(item.path)}`);
  } catch (e) { return; }
  if (!r.path || !img.isConnected) return;
  const media = lb.querySelector(".lightbox-media");
  const under = el(`<img class="reveal-under hidden" draggable="false"
    src="/file?path=${encodeURIComponent(r.path)}">`);
  const badge = el(`<div class="reveal-badge">hold ⇄ ${r.label}</div>`);
  media.append(under, badge);
  img.classList.add("reveal-top");
  img.draggable = false;

  const fit = () => {
    const a = img.getBoundingClientRect(), m = media.getBoundingClientRect();
    Object.assign(under.style, { left: `${a.left - m.left}px`, top: `${a.top - m.top}px`,
      width: `${a.width}px`, height: `${a.height}px` });
  };
  const show = (e) => {
    if (e.button > 0) return;
    fit();
    under.classList.remove("hidden");
    badge.textContent = `${r.label}`;
    badge.classList.add("on");
  };
  const hide = () => {
    under.classList.add("hidden");
    badge.textContent = `hold ⇄ ${r.label}`;
    badge.classList.remove("on");
  };
  // The revealed image is click-through, so the press stays on the top image; release
  // is watched on window so letting go anywhere (or a cancelled touch) restores it.
  img.addEventListener("pointerdown", show);
  const onUp = () => { if (!img.isConnected) return drop(); hide(); };
  const drop = () => ["pointerup", "pointercancel"].forEach((ev) => window.removeEventListener(ev, onUp));
  ["pointerup", "pointercancel"].forEach((ev) => window.addEventListener(ev, onUp));
  img.addEventListener("contextmenu", (e) => e.preventDefault());
}

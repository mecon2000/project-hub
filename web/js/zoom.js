// Mouse-wheel / pinch zoom and drag-to-pan for a picture inside a clipping stage.
// Generic: `frame` is the element that scales (an <img>, or a wrapper holding the img + overlays),
// `stage` the box that clips it. Double-click resets. Children can read the zoom from the CSS var --z
// (e.g. to keep pins the same size on screen). A drag never counts as a click on the picture.
export function attachZoom(stage, frame, { max = 10, onChange } = {}) {
  let z = 1, tx = 0, ty = 0, moved = false;
  const pts = new Map();          // active pointers
  let start = null;               // gesture start: {z, tx, ty, cx, cy, dist}
  stage.style.overflow = "hidden";
  if (getComputedStyle(stage).position === "static") stage.style.position = "relative";
  frame.style.transformOrigin = "0 0";

  const clamp = () => {
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const fw = frame.offsetWidth * z, fh = frame.offsetHeight * z;
    const ox = frame.offsetLeft, oy = frame.offsetTop;
    if (z === 1) { tx = ty = 0; return; }
    // smaller than the stage on an axis: centred; bigger: no empty margin may open on either side
    tx = fw <= sw ? (sw - fw) / 2 - ox : Math.min(-ox, Math.max(sw - fw - ox, tx));
    ty = fh <= sh ? (sh - fh) / 2 - oy : Math.min(-oy, Math.max(sh - fh - oy, ty));
  };
  const apply = () => {
    clamp();
    frame.style.transform = z === 1 ? "" : `translate(${tx}px, ${ty}px) scale(${z})`;
    frame.style.setProperty("--z", z);
    stage.classList.toggle("zoomed", z > 1);
    onChange && onChange(z);
  };
  // zoom to `nz`, keeping the screen point (px, py) over the same spot of the picture
  const zoomAt = (nz, px, py) => {
    nz = Math.max(1, Math.min(max, nz));
    const r = frame.getBoundingClientRect();
    const u = (px - r.left) / z, v = (py - r.top) / z;
    tx += px - u * nz - r.left; ty += py - v * nz - r.top;
    z = nz; apply();
  };

  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    zoomAt(z * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY);   // ctrl = trackpad pinch
  }, { passive: false });

  const mid = () => { const [a, b] = [...pts.values()]; return b ? [(a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y)] : [a.x, a.y, 0]; };
  const begin = () => { const [cx, cy, dist] = mid(); start = { z, tx, ty, cx, cy, dist }; };
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) moved = false;
    begin();
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [cx, cy, dist] = mid();
    if (Math.hypot(cx - start.cx, cy - start.cy) > 4 || pts.size > 1) moved = true;
    if (!moved) return;
    if (pts.size > 1 && start.dist > 0) {                       // pinch, anchored on the fingers' midpoint
      z = start.z; tx = start.tx; ty = start.ty; apply();
      zoomAt(start.z * dist / start.dist, start.cx, start.cy);
      tx += cx - start.cx; ty += cy - start.cy; apply();
    } else if (z > 1) {                                          // pan
      tx = start.tx + cx - start.cx; ty = start.ty + cy - start.cy; apply();
    }
    if (z > 1 || pts.size > 1) stage.setPointerCapture?.(e.pointerId);
  });
  const end = (e) => { pts.delete(e.pointerId); if (pts.size) begin(); };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("click", (e) => { if (moved && z > 1) { e.stopPropagation(); e.preventDefault(); } moved = false; }, true);
  stage.addEventListener("dragstart", (e) => e.preventDefault());    // no native image drag-and-drop
  stage.addEventListener("dblclick", (e) => { e.preventDefault(); z = 1; apply(); });
  window.addEventListener("resize", apply);

  return {
    reset() { z = 1; apply(); },
    get zoom() { return z; },
    // the part of the picture currently on screen, as fractions 0..1 of the image (for snapshots)
    visible(img = frame) {
      const r = img.getBoundingClientRect(), s = stage.getBoundingClientRect();
      const x0 = Math.max(r.left, s.left), x1 = Math.min(r.right, s.right);
      const y0 = Math.max(r.top, s.top), y1 = Math.min(r.bottom, s.bottom);
      return { x: (x0 - r.left) / r.width, y: (y0 - r.top) / r.height, w: (x1 - x0) / r.width, h: (y1 - y0) / r.height };
    },
  };
}

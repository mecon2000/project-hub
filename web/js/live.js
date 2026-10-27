// Keeps an open page current without a manual reload: polls /api/p/<name>/version and, when a new
// area (e.g. a new review round) or new media shows up, reloads the project list and re-renders the
// current view in place. Never yanks the page while an overlay is open or the viewer is typing —
// it waits for the next tick instead. Silent on network blips (phones drop off the tailnet).
import { state, toast } from "./app.js";

const EVERY = 20000;
let last = null;
let busy = false;

function blocked() {
  if (document.querySelector(".ann-editor, .compare-overlay, #lightbox:not(.hidden), dialog[open]")) return true;
  const a = document.activeElement;
  return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}

async function tick(onChange) {
  if (document.hidden || busy || !state.project) return;
  const p = state.project;
  let v;
  try {
    const r = await fetch(`/api/p/${encodeURIComponent(p)}/version`, { cache: "no-store" });
    if (!r.ok) return;
    v = await r.json();
  } catch (e) { return; }
  if (!last || last.p !== p) { last = { p, ...v }; return; }        // first look at this project
  const newAreas = v.areas.filter((a) => !last.areas.includes(a));
  const areasChanged = v.areas.join("|") !== last.areas.join("|");
  const media = v.media !== last.media;
  // notes.json also moves when THIS viewer clicks; only follow it when we haven't written lately
  const notes = v.notes !== last.notes && Date.now() - (state.lastWrite || 0) > 2 * EVERY;
  const onGallery = state.tab === "gallery" || state.tab === "home";
  if (!areasChanged && !((media || notes) && onGallery)) { last = { p, ...v }; return; }
  if (onGallery && blocked()) return;                                // retry next tick
  last = { p, ...v };
  busy = true;
  try { await onChange({ rerender: onGallery }); } catch (e) { /* next tick */ } finally { busy = false; }
  if (newAreas.length) toast(`New: ${newAreas.join(", ")}`, 6000);
  else if (media && onGallery) toast("New pictures arrived", 3000);
}

export function startLive(onChange) {
  setInterval(() => tick(onChange), EVERY);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(onChange); });
}

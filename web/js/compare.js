import { el } from "./app.js";
import { attachVideo } from "./viewer.js";

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Fullscreen side-by-side compare of two videos with a shared master control row.
export function openCompare(pathA, pathB, labelA = "A", labelB = "B") {
  const overlay = el(`<div class="compare-overlay">
    <div class="compare-top">
      <div class="muted">Compare</div>
      <button class="lightbox-close" id="cmpClose">✕</button>
    </div>
    <div class="compare-row" id="cmpRowA">
      <div class="compare-label">${labelA}</div>
    </div>
    <div class="compare-row" id="cmpRowB">
      <div class="compare-label">${labelB}</div>
    </div>
    <div class="compare-controls">
      <button class="btn secondary" id="cmpPlay">Play</button>
      <input type="range" id="cmpSeek" min="0" max="0" step="0.1" value="0">
      <span class="muted" id="cmpTime">0:00</span>
      <label class="checkbox-row" style="margin:0"><input type="checkbox" id="cmpLoop"><span>Loop</span></label>
    </div>
  </div>`);
  document.body.appendChild(overlay);

  const rowA = overlay.querySelector("#cmpRowA");
  const rowB = overlay.querySelector("#cmpRowB");
  const viewerA = attachVideo(rowA, pathA, { autoplay: false });
  const viewerB = attachVideo(rowB, pathB, { autoplay: false });

  const playBtn = overlay.querySelector("#cmpPlay");
  const seek = overlay.querySelector("#cmpSeek");
  const timeEl = overlay.querySelector("#cmpTime");
  const loopEl = overlay.querySelector("#cmpLoop");

  let playing = false;
  let seeking = false;
  let rafTimer = null;

  function videos() {
    return [viewerA.getVideo(), viewerB.getVideo()].filter(Boolean);
  }

  function updateSeekMax() {
    const vs = videos();
    if (vs.length < 2) return;
    const durA = vs[0].duration;
    const durB = vs[1].duration;
    if (isFinite(durA) && isFinite(durB)) {
      seek.max = Math.min(durA, durB);
    }
  }

  function tick() {
    const vs = videos();
    if (vs.length && !seeking) {
      const t = vs[0].currentTime;
      seek.value = t;
      timeEl.textContent = fmtTime(t);
      updateSeekMax();
      if (loopEl.checked && seek.max && t >= parseFloat(seek.max)) {
        vs.forEach((v) => { v.currentTime = 0; });
      }
    }
    rafTimer = requestAnimationFrame(tick);
  }
  rafTimer = requestAnimationFrame(tick);

  playBtn.addEventListener("click", () => {
    const vs = videos();
    if (!vs.length) return;
    playing = !playing;
    if (playing) {
      vs.forEach((v) => v.play().catch(() => {}));
      playBtn.textContent = "Pause";
    } else {
      vs.forEach((v) => v.pause());
      playBtn.textContent = "Play";
    }
  });

  seek.addEventListener("input", () => {
    seeking = true;
    const t = parseFloat(seek.value);
    videos().forEach((v) => { v.currentTime = t; });
    timeEl.textContent = fmtTime(t);
  });
  seek.addEventListener("change", () => { seeking = false; });

  function close() {
    cancelAnimationFrame(rafTimer);
    if (viewerA.el._stop) viewerA.el._stop();
    if (viewerB.el._stop) viewerB.el._stop();
    document.removeEventListener("keydown", keyHandler);
    videos().forEach((v) => v.pause());
    overlay.remove();
  }
  function keyHandler(e) {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", keyHandler);
  overlay.querySelector("#cmpClose").addEventListener("click", close);

  return { close };
}

import { el } from "./app.js";

// Shared video viewer: probes /video-preview, shows spinner while preparing,
// falls back to original on failure, and offers an HD toggle (proxy <-> original).
export function attachVideo(container, path, opts = {}) {
  const autoplay = !!opts.autoplay;
  const wrap = el(`<div class="video-viewer">
    <div class="video-viewer-media">
      <div class="video-spinner-wrap"><div class="spinner"></div><div class="muted">preparing preview…</div></div>
    </div>
  </div>`);
  container.appendChild(wrap);
  const mediaWrap = wrap.querySelector(".video-viewer-media");

  let video = null;
  let usingProxy = false;
  let pollTimer = null;
  let pollDeadline = null;
  let stopped = false;

  function makeVideo(src, opts2 = {}) {
    const v = document.createElement("video");
    v.controls = true;
    v.playsInline = true;
    v.src = src;
    if (opts2.autoplay) v.autoplay = true;
    return v;
  }

  function showNote(text) {
    const note = el(`<div class="video-note muted">${text}</div>`);
    wrap.appendChild(note);
  }

  function addHdToggle() {
    const btn = el(`<button class="hd-toggle">HD</button>`);
    btn.classList.toggle("active", !usingProxy);
    btn.addEventListener("click", () => {
      if (!video) return;
      const t = video.currentTime || 0;
      const wasPlaying = !video.paused;
      usingProxy = !usingProxy;
      video.src = usingProxy
        ? `/video-preview?path=${encodeURIComponent(path)}`
        : `/file?path=${encodeURIComponent(path)}`;
      btn.classList.toggle("active", !usingProxy);
      const onReady = () => {
        video.currentTime = t;
        if (wasPlaying) video.play().catch(() => {});
        video.removeEventListener("loadedmetadata", onReady);
      };
      video.addEventListener("loadedmetadata", onReady);
    });
    wrap.appendChild(btn);
  }

  function swapToVideo(src, proxy) {
    usingProxy = proxy;
    mediaWrap.innerHTML = "";
    video = makeVideo(src, { autoplay });
    mediaWrap.appendChild(video);
    addHdToggle();
  }

  async function probe() {
    if (stopped) return;
    let data;
    try {
      data = await fetch(`/video-preview?path=${encodeURIComponent(path)}&probe=1`).then((r) => r.json());
    } catch (e) {
      data = { status: "failed" };
    }
    if (stopped) return;
    if (data.status === "ready") {
      swapToVideo(`/video-preview?path=${encodeURIComponent(path)}`, true);
    } else if (data.status === "failed") {
      swapToVideo(`/file?path=${encodeURIComponent(path)}`, false);
      showNote("(no preview — original)");
    } else {
      // preparing: poll every 3s, give up after 30 min
      if (!pollDeadline) pollDeadline = Date.now() + 30 * 60 * 1000;
      if (Date.now() > pollDeadline) {
        swapToVideo(`/file?path=${encodeURIComponent(path)}`, false);
        showNote("(no preview — original)");
        return;
      }
      pollTimer = setTimeout(probe, 3000);
    }
  }

  probe();

  wrap._stop = () => {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
  };

  return {
    el: wrap,
    getVideo: () => video,
  };
}

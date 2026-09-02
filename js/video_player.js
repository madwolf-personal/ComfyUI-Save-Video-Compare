import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

function formatTime(s) {
    if (!isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
}

function styleBtn(b) {
    b.style.background = "#2a2a2a";
    b.style.color = "#ddd";
    b.style.border = "1px solid #444";
    b.style.borderRadius = "3px";
    b.style.padding = "2px 6px";
    b.style.cursor = "pointer";
    b.style.fontSize = "11px";
    b.style.lineHeight = "14px";
    b.style.flexShrink = "0";
}

function styleSelect(s) {
    s.style.background = "#2a2a2a";
    s.style.color = "#ddd";
    s.style.border = "1px solid #444";
    s.style.borderRadius = "3px";
    s.style.fontSize = "11px";
    s.style.cursor = "pointer";
    s.style.flexShrink = "0";
}

const BAR_HEIGHT = 26;

// `nodeType.prototype.onExecuted` is only invoked by ComfyUI for nodes
// that are part of the currently loaded/active graph. Switching to a
// different workflow tab swaps out the in-memory graph, so if a run
// finishes while you're on another tab, the node instance for the
// finished run never receives onExecuted and its result never gets
// cached to localStorage — leaving the player showing the previous run.
//
// `api` (the websocket client), on the other hand, receives "executed"
// events globally regardless of which tab/graph is currently active, so
// we mirror the result into localStorage from there too. This listener
// is registered once at module load, not per-node, so it keeps working
// even while this node isn't mounted anywhere.
//
// Live-updating the actual <video> element is trickier: `app.graph` only
// points at whichever tab's graph is currently active, so
// `app.graph._nodes_by_id` misses nodes that are mounted but sitting in a
// background tab. If we only checked that map, a run finishing while
// you're on another tab would still update localStorage correctly, but
// the already-mounted node in the background tab would never get its
// videoPlayerLoad() call — it would keep showing the previous video's
// <video src> until the whole page was reloaded (onConfigure, the only
// other place that reloads from localStorage, only fires on
// load/deserialize, not on a plain tab switch).
//
// So instead we track every mounted instance ourselves, keyed by node id,
// in a registry that isn't tied to any one graph. onNodeCreated adds to
// it, onRemoved cleans it up, and the "executed" listener below looks a
// node up here directly rather than through app.graph.
//
// Caveat: node ids are only unique within a single graph, so if two
// different open tabs each happen to contain a VideoPlayerNode with the
// same id, the later-created one wins the registry slot and the earlier
// one won't get live-updated (it'll still catch up via localStorage next
// time it's actually reloaded/reconfigured). This is a narrower edge case
// than the original bug, which failed for every background tab, always.
const mountedVideoPlayerNodes = new Map();

let globalExecutedListenerAdded = false;
function ensureGlobalExecutedListener() {
    if (globalExecutedListenerAdded) return;
    globalExecutedListenerAdded = true;
    api.addEventListener("executed", (event) => {
        const detail = event.detail;
        if (!detail || !detail.output) return;
        const outA = detail.output.video_path_a;
        const outB = detail.output.video_path_b;
        if (!outA && !outB) return;
        const pA = outA ? outA[0] : "";
        const pB = outB ? outB[0] : "";
        try {
            localStorage.setItem("videoPlayerPathA_" + detail.node, pA || "");
            localStorage.setItem("videoPlayerPathB_" + detail.node, pB || "");
        } catch (e) {}
        // Update the live node wherever it's mounted — active tab or not.
        const liveNode = mountedVideoPlayerNodes.get(detail.node);
        if (liveNode && liveNode.videoPlayerLoad) {
            liveNode.videoPlayerLoad({ a: pA, b: pB }, true);
        }
    });
}

app.registerExtension({
    name: "video_player.custom",
    async beforeRegisterNodeDef(nodeType, nodeData, appRef) {
        if (nodeData.name !== "VideoPlayerNode") return;
        ensureGlobalExecutedListener();

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            const node = this;
            mountedVideoPlayerNodes.set(node.id, node);

            // Persist control settings (loop/speed/volume/mute) and the
            // last played A/B paths in localStorage, keyed by this node's
            // id, so they survive tab switches without needing visible
            // (or hidden, which is buggy) path widgets.
            const settingsKey = "videoPlayerSettings_" + node.id;
            const pathKeyA = "videoPlayerPathA_" + node.id;
            const pathKeyB = "videoPlayerPathB_" + node.id;

            function readSettings() {
                try {
                    const raw = localStorage.getItem(settingsKey);
                    if (raw) return Object.assign({ loop: false, speed: 1, volume: 1, muted: false, autoplay: false }, JSON.parse(raw));
                } catch (e) {}
                return { loop: false, speed: 1, volume: 1, muted: false, autoplay: false };
            }
            function writeSettings(partial) {
                const merged = Object.assign(readSettings(), partial);
                try {
                    localStorage.setItem(settingsKey, JSON.stringify(merged));
                } catch (e) {}
                return merged;
            }
            function readLastPaths() {
                try {
                    return {
                        a: localStorage.getItem(pathKeyA) || "",
                        b: localStorage.getItem(pathKeyB) || "",
                    };
                } catch (e) {
                    return { a: "", b: "" };
                }
            }
            function writeLastPaths(a, b) {
                try {
                    localStorage.setItem(pathKeyA, a || "");
                    // An empty string here (vs. removing the key) is
                    // intentional: it distinguishes "ran with a B video
                    // once, now cleared" from "never had a B video", though
                    // both currently behave the same way on read. Kept
                    // simple and consistent with pathKeyA.
                    localStorage.setItem(pathKeyB, b || "");
                } catch (e) {}
            }
            const settings = readSettings();

            const container = document.createElement("div");
            container.style.width = "100%";
            container.style.height = "100%";
            container.style.display = "flex";
            container.style.flexDirection = "column";
            container.style.background = "#000";
            container.style.borderRadius = "4px";
            container.style.overflow = "hidden";
            container.style.fontFamily = "sans-serif";
            container.style.boxSizing = "border-box";

            const stage = document.createElement("div");
            stage.style.position = "relative";
            stage.style.width = "100%";
            stage.style.flex = "1 1 0";
            stage.style.minHeight = "0";
            stage.style.background = "#000";
            container.appendChild(stage);

            const video = document.createElement("video");
            video.style.position = "absolute";
            video.style.inset = "0";
            video.style.width = "100%";
            video.style.height = "100%";
            video.style.display = "block";
            video.style.background = "#000";
            video.style.objectFit = "contain";
            video.preload = "metadata";
            video.playsInline = true;
            stage.appendChild(video);

            // --- Compare (A/B) mode ---
            // videoB sits in a clipped wrapper stacked exactly on top of
            // videoA. The wrapper's clip-path reveals only the left
            // `sliderPct`% of videoB, so what's actually visible is A on
            // the right and B on the left of the divider — a swipe
            // comparison, driven by an ordinary <input type=range> rather
            // than a draggable on-video handle, to keep this simple and
            // keep the resizing behavior untouched (nothing here affects
            // the node/DOM-widget sizing below).
            const clipWrap = document.createElement("div");
            clipWrap.style.position = "absolute";
            clipWrap.style.inset = "0";
            clipWrap.style.display = "none"; // shown only in compare mode
            // This overlay sits on top of video A. Without this, hovering
            // or clicking anywhere over video B's (left) side would hit
            // this div/videoB instead of video A underneath — showing the
            // browser's native "grab" cursor (video elements are
            // draggable by default) and silently eating the
            // click-to-toggle-play handler that's bound to video A. Since
            // video B has no controls of its own anyway (it just mirrors
            // A), there's nothing lost by letting all pointer interaction
            // fall through to A everywhere in the stage.
            clipWrap.style.pointerEvents = "none";
            stage.appendChild(clipWrap);

            const videoB = document.createElement("video");
            videoB.style.position = "absolute";
            videoB.style.inset = "0";
            videoB.style.width = "100%";
            videoB.style.height = "100%";
            videoB.style.display = "block";
            videoB.style.background = "#000";
            videoB.style.objectFit = "contain";
            videoB.preload = "metadata";
            videoB.playsInline = true;
            videoB.muted = true; // avoid doubled audio; A carries sound
            videoB.draggable = false;
            videoB.style.webkitUserDrag = "none";
            videoB.style.pointerEvents = "none";
            clipWrap.appendChild(videoB);

            const divider = document.createElement("div");
            divider.style.position = "absolute";
            divider.style.top = "0";
            divider.style.bottom = "0";
            divider.style.width = "2px";
            divider.style.background = "#fff";
            divider.style.boxShadow = "0 0 3px rgba(0,0,0,0.8)";
            divider.style.pointerEvents = "none";
            divider.style.display = "none"; // shown only in compare mode
            stage.appendChild(divider);

            const labelA = document.createElement("span");
            labelA.textContent = "A";
            const labelB = document.createElement("span");
            labelB.textContent = "B";
            [labelA, labelB].forEach((l) => {
                l.style.position = "absolute";
                l.style.top = "4px";
                l.style.padding = "1px 5px";
                l.style.background = "rgba(0,0,0,0.55)";
                l.style.color = "#fff";
                l.style.fontSize = "10px";
                l.style.borderRadius = "3px";
                l.style.pointerEvents = "none";
                l.style.display = "none"; // shown only in compare mode
            });
            labelA.style.right = "4px";
            labelB.style.left = "4px";
            stage.appendChild(labelA);
            stage.appendChild(labelB);

            let dividerPct = 50;
            function setDividerPct(pct) {
                dividerPct = pct;
                clipWrap.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
                divider.style.left = `calc(${pct}% - 1px)`;
            }
            setDividerPct(50);

            function setCompareMode(on) {
                clipWrap.style.display = on ? "block" : "none";
                divider.style.display = on ? "block" : "none";
                labelA.style.display = on ? "block" : "none";
                labelB.style.display = on ? "block" : "none";
                if (!on) {
                    videoB.pause();
                    videoB.removeAttribute("src");
                }
            }

            // --- Drag the divider directly on the video ---
            // Dragging only starts when the pointer goes down within a few
            // pixels of the divider line itself — not anywhere on the
            // video — so a plain click elsewhere on the video still always
            // toggles play/pause without any ambiguity about intent.
            const DIVIDER_HIT_PX = 10;
            let dividerDragActive = false;

            function updateDividerFromClientX(clientX) {
                const rect = stage.getBoundingClientRect();
                if (rect.width <= 0) return;
                let pct = ((clientX - rect.left) / rect.width) * 100;
                pct = Math.min(Math.max(pct, 0), 100);
                setDividerPct(pct);
            }

            stage.style.touchAction = "none";
            stage.addEventListener("pointerdown", (e) => {
                if (clipWrap.style.display === "none") return; // single mode
                if (e.button !== undefined && e.button !== 0) return;
                const rect = stage.getBoundingClientRect();
                if (rect.width <= 0) return;
                const dividerX = rect.left + (dividerPct / 100) * rect.width;
                if (Math.abs(e.clientX - dividerX) > DIVIDER_HIT_PX) return;
                dividerDragActive = true;
                // A drag starting on the divider line was never a
                // play/pause click to begin with, so suppress the
                // trailing click event unconditionally rather than only
                // after actual movement.
                suppressNextClick = true;
                e.preventDefault();
                try {
                    stage.setPointerCapture(e.pointerId);
                } catch (err) {}
            });
            stage.addEventListener("pointermove", (e) => {
                if (!dividerDragActive) return;
                e.preventDefault();
                updateDividerFromClientX(e.clientX);
            });
            function endDividerDrag(e) {
                if (!dividerDragActive) return;
                dividerDragActive = false;
                setTimeout(() => {
                    suppressNextClick = false;
                }, 0);
            }
            stage.addEventListener("pointermove", (e) => {
                if (dividerDragActive) return; // already handled above
                if (clipWrap.style.display === "none") return; // single mode
                const rect = stage.getBoundingClientRect();
                if (rect.width <= 0) return;
                const dividerX = rect.left + (dividerPct / 100) * rect.width;
                video.style.cursor =
                    Math.abs(e.clientX - dividerX) <= DIVIDER_HIT_PX ? "ew-resize" : "pointer";
            });

            stage.addEventListener("pointerup", endDividerDrag);
            stage.addEventListener("pointercancel", endDividerDrag);

            const bar = document.createElement("div");
            bar.style.display = "flex";
            bar.style.alignItems = "center";
            bar.style.gap = "6px";
            bar.style.padding = "4px 6px";
            bar.style.background = "#181818";
            bar.style.color = "#ddd";
            bar.style.fontSize = "11px";
            bar.style.flex = `0 0 ${BAR_HEIGHT}px`;
            bar.style.boxSizing = "border-box";
            container.appendChild(bar);

            const playBtn = document.createElement("button");
            playBtn.textContent = "\u25B6";
            styleBtn(playBtn);
            bar.appendChild(playBtn);

            const timeLabel = document.createElement("span");
            timeLabel.textContent = "0:00 / 0:00";
            timeLabel.style.minWidth = "70px";
            timeLabel.style.whiteSpace = "nowrap";
            timeLabel.style.flexShrink = "0";
            bar.appendChild(timeLabel);

            const seek = document.createElement("input");
            seek.type = "range";
            seek.min = 0;
            seek.max = 1000;
            seek.value = 0;
            seek.style.flex = "1 1 auto";
            seek.style.minWidth = "30px";
            seek.style.cursor = "pointer";
            bar.appendChild(seek);

            const loopBtn = document.createElement("button");
            loopBtn.dataset.loop = settings.loop ? "on" : "off";
            loopBtn.textContent = settings.loop ? "loop:on" : "loop:off";
            styleBtn(loopBtn);
            bar.appendChild(loopBtn);

            const speedSelect = document.createElement("select");
            [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].forEach((v) => {
                const opt = document.createElement("option");
                opt.value = v;
                opt.textContent = v + "x";
                if (v === settings.speed) opt.selected = true;
                speedSelect.appendChild(opt);
            });
            styleSelect(speedSelect);
            bar.appendChild(speedSelect);

            const muteBtn = document.createElement("button");
            muteBtn.textContent = settings.muted ? "\uD83D\uDD07" : "\uD83D\uDD0A";
            styleBtn(muteBtn);
            bar.appendChild(muteBtn);

            const volume = document.createElement("input");
            volume.type = "range";
            volume.min = 0;
            volume.max = 1;
            volume.step = 0.01;
            volume.value = settings.volume;
            volume.style.width = "50px";
            volume.style.flexShrink = "0";
            volume.style.cursor = "pointer";
            bar.appendChild(volume);

            const fullscreenBtn = document.createElement("button");
            fullscreenBtn.textContent = "\u26F6";
            fullscreenBtn.title = "Fullscreen (F)";
            styleBtn(fullscreenBtn);
            bar.appendChild(fullscreenBtn);

            const autoplayBtn = document.createElement("button");
            autoplayBtn.dataset.autoplay = settings.autoplay ? "on" : "off";
            autoplayBtn.textContent = settings.autoplay ? "auto:on" : "auto:off";
            autoplayBtn.title = "Autoplay new videos (A)";
            styleBtn(autoplayBtn);
            bar.appendChild(autoplayBtn);

            const dimsLabel = document.createElement("span");
            dimsLabel.textContent = "";
            dimsLabel.style.whiteSpace = "nowrap";
            dimsLabel.style.flexShrink = "0";
            dimsLabel.style.marginLeft = "auto";
            dimsLabel.style.paddingLeft = "6px";
            dimsLabel.style.color = "#999";
            bar.appendChild(dimsLabel);

            video.loop = settings.loop;
            video.playbackRate = settings.speed;
            video.volume = settings.volume;
            video.muted = settings.muted;

            let seeking = false;
            let suppressNextClick = false;

            playBtn.onclick = () => {
                if (video.paused) video.play();
                else video.pause();
            };
            video.addEventListener("play", () => (playBtn.textContent = "\u23F8"));
            video.addEventListener("pause", () => (playBtn.textContent = "\u25B6"));
            video.addEventListener("ended", () => (playBtn.textContent = "\u25B6"));
            video.style.cursor = "pointer";
            video.addEventListener("click", () => {
                if (suppressNextClick) {
                    suppressNextClick = false;
                    return;
                }
                if (video.paused) video.play();
                else video.pause();
            });

            video.addEventListener("timeupdate", () => {
                if (!seeking && video.duration) {
                    seek.value = (video.currentTime / video.duration) * 1000;
                }
                timeLabel.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
            });
            video.addEventListener("loadedmetadata", () => {
                timeLabel.textContent = `${formatTime(0)} / ${formatTime(video.duration)}`;
                if (video.videoWidth && video.videoHeight) {
                    dimsLabel.textContent = `${video.videoWidth}\u00D7${video.videoHeight}`;
                } else {
                    dimsLabel.textContent = "";
                }
            });

            // seek.addEventListener("input", () => {
                // seeking = true;
                // if (video.duration) {
                    // video.currentTime = (seek.value / 1000) * video.duration;
                // }
            // });
			
			
			// ===================================================
			seek.addEventListener("input", () => {
                seeking = true;
                if (video.duration) {
                    const t = (seek.value / 1000) * video.duration;
                    video.currentTime = t;
                    if (videoB.src) {
                        videoB.currentTime = t;
                    }
                }
            });
			// ========================================================
			
            seek.addEventListener("change", () => {
                seeking = false;
            });

            loopBtn.onclick = () => {
                video.loop = !video.loop;
                loopBtn.dataset.loop = video.loop ? "on" : "off";
                loopBtn.textContent = video.loop ? "loop:on" : "loop:off";
                writeSettings({ loop: video.loop });
                // Turning loop on should always resume playback if the
                // video is currently paused/ended, not just when the
                // "ended" flag is strictly true.
                if (video.loop && video.paused) {
                    if (video.ended || video.currentTime >= video.duration - 0.05) {
                        video.currentTime = 0;
                    }
                    video.play().catch(() => {});
                }
            };

            speedSelect.onchange = () => {
                video.playbackRate = parseFloat(speedSelect.value);
                writeSettings({ speed: video.playbackRate });
            };

            muteBtn.onclick = () => {
                video.muted = !video.muted;
                muteBtn.textContent = video.muted ? "\uD83D\uDD07" : "\uD83D\uDD0A";
                writeSettings({ muted: video.muted });
            };
            autoplayBtn.onclick = () => {
                const next = !(readSettings().autoplay);
                autoplayBtn.dataset.autoplay = next ? "on" : "off";
                autoplayBtn.textContent = next ? "auto:on" : "auto:off";
                writeSettings({ autoplay: next });
            };
            volume.addEventListener("input", () => {
                video.volume = parseFloat(volume.value);
                let muted = video.muted;
                if (video.volume === 0) {
                    video.muted = true;
                    muteBtn.textContent = "\uD83D\uDD07";
                    muted = true;
                } else if (video.muted) {
                    video.muted = false;
                    muteBtn.textContent = "\uD83D\uDD0A";
                    muted = false;
                }
                writeSettings({ volume: video.volume, muted });
            });

            // --- Fullscreen ---
            function toggleFullscreen() {
                if (!document.fullscreenElement) {
                    (container.requestFullscreen
                        ? container
                        : video
                    ).requestFullscreen().catch(() => {});
                } else {
                    document.exitFullscreen().catch(() => {});
                }
            }
            fullscreenBtn.onclick = toggleFullscreen;
            video.addEventListener("dblclick", toggleFullscreen);

            let isHovered = false;
            container.addEventListener("mouseenter", () => (isHovered = true));
            container.addEventListener("mouseleave", () => (isHovered = false));

            // --- Keep videoB following videoA whenever it's loaded ---
            // videoB has no controls of its own; it's a silent mirror of
            // videoA's play/pause/seek/rate state, driven off A's events.
            // Drift correction on timeupdate handles the normal small gaps
            // between two independently-decoding <video> elements.
            
			
			// function syncBFromA() {
                // if (!videoB.src) return;
                // if (video.paused && !videoB.paused) videoB.pause();
                // if (!video.paused && videoB.paused) videoB.play().catch(() => {});
                // videoB.playbackRate = video.playbackRate;
                // videoB.loop = video.loop;
                // if (Math.abs(videoB.currentTime - video.currentTime) > 0.15) {
                    // videoB.currentTime = video.currentTime;
                // }
            // }
			
			// ====================================================
			function syncBFromA(e) {
                if (!videoB.src) return;
                if (video.paused && !videoB.paused) videoB.pause();
                if (!video.paused && videoB.paused) videoB.play().catch(() => {});
                videoB.playbackRate = video.playbackRate;
                videoB.loop = video.loop;

                // When paused or seeking, sync tightly (~10ms) so frames match exactly.
                // During active playback, keep the 150ms deadband to prevent decode stutter.
                const isPausedOrSeeking = video.paused || (e && e.type === "seeked");
                const threshold = isPausedOrSeeking ? 0.01 : 0.15;
                if (Math.abs(videoB.currentTime - video.currentTime) > threshold) {
                    videoB.currentTime = video.currentTime;
                }
            }
			// ====================================================
			
			
            video.addEventListener("play", syncBFromA);
            video.addEventListener("pause", syncBFromA);
            video.addEventListener("seeked", syncBFromA);
            video.addEventListener("ratechange", syncBFromA);
            video.addEventListener("timeupdate", syncBFromA);

            const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

            // HTML5 <video> has no reliable cross-browser API for the
            // source's actual frame rate (requestVideoFrameCallback gives
            // per-frame callbacks in Chromium, but not a frame-duration or
            // fps value, and isn't available everywhere). We approximate a
            // "frame" as 1/30s, which is a reasonable default for typical
            // ComfyUI video outputs. It won't land exactly on a real frame
            // boundary for other frame rates, but it's a small, consistent
            // step either way.
            const FRAME_STEP = 1 / 30;

            // function stepFrame(direction) {
                // video.pause();
                // const duration = isFinite(video.duration) ? video.duration : Infinity;
                // let t = video.currentTime + direction * FRAME_STEP;
                // t = Math.min(Math.max(t, 0), duration);
                // video.currentTime = t;
            // }
			
			// ====================================================
			function stepFrame(direction) {
                video.pause();
                if (videoB.src) videoB.pause();

                const duration = isFinite(video.duration) ? video.duration : Infinity;
                let t = video.currentTime + direction * FRAME_STEP;
                t = Math.min(Math.max(t, 0), duration);
                video.currentTime = t;

                if (videoB.src) {
                    const durB = isFinite(videoB.duration) ? videoB.duration : duration;
                    videoB.currentTime = Math.min(Math.max(t, 0), durB);
                }
            }
			// ==================================================

            function setSpeed(v) {
                video.playbackRate = v;
                speedSelect.value = v;
                writeSettings({ speed: v });
            }

            function closestSpeedIndex() {
                let idx = SPEEDS.indexOf(video.playbackRate);
                if (idx !== -1) return idx;
                // fall back to nearest speed if playbackRate isn't one of our presets
                let best = 0;
                let bestDiff = Infinity;
                SPEEDS.forEach((s, i) => {
                    const diff = Math.abs(s - video.playbackRate);
                    if (diff < bestDiff) {
                        bestDiff = diff;
                        best = i;
                    }
                });
                return best;
            }

            function onKeyDown(e) {
                if (!isHovered) return;
                const key = e.key.toLowerCase();
                if (!["f", " ", "m", "l", "a", ",", ".", "/", "n", "b"].includes(key)) return;
                const active = document.activeElement;
                if (
                    active &&
                    (active.tagName === "INPUT" ||
                        active.tagName === "TEXTAREA" ||
                        active.isContentEditable)
                ) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                if (key === "f") {
                    toggleFullscreen();
                } else if (key === " ") {
                    if (video.paused) video.play();
                    else video.pause();
                } else if (key === "m") {
                    muteBtn.onclick();
                } else if (key === "l") {
                    loopBtn.onclick();
                } else if (key === "a") {
                    autoplayBtn.onclick();
                } else if (key === ",") {
                    const idx = closestSpeedIndex();
                    setSpeed(SPEEDS[Math.max(idx - 1, 0)]);
                } else if (key === ".") {
                    const idx = closestSpeedIndex();
                    setSpeed(SPEEDS[Math.min(idx + 1, SPEEDS.length - 1)]);
                } else if (key === "/") {
                    setSpeed(1);
                } else if (key === "n") {
                    stepFrame(1);
                } else if (key === "b") {
                    stepFrame(-1);
                }
            }
            // Capture phase so this runs before ComfyUI's own global
            // shortcut handlers (which use bubble-phase listeners),
            // letting us stop the event before it reaches them.
            window.addEventListener("keydown", onKeyDown, true);

            const onRemoved = node.onRemoved;
            node.onRemoved = function () {
                window.removeEventListener("keydown", onKeyDown, true);
                if (mountedVideoPlayerNodes.get(node.id) === node) {
                    mountedVideoPlayerNodes.delete(node.id);
                }
                if (onRemoved) onRemoved.apply(this, arguments);
            };

            function stripQuotes(p) {
                if (typeof p !== "string") return p;
                let v = p.trim();
                if (
                    (v.startsWith('"') && v.endsWith('"')) ||
                    (v.startsWith("'") && v.endsWith("'"))
                ) {
                    v = v.slice(1, -1);
                }
                return v;
            }

            function loadPaths({ a, b } = {}, autoplay = false) {
                a = stripQuotes(a);
                b = stripQuotes(b);

                if (!a) {
                    video.removeAttribute("src");
                    dimsLabel.textContent = "";
                } else {
                    video.src = "/video_player/stream?path=" + encodeURIComponent(a);
                    const playWhenReady = () => {
                        video.removeEventListener("canplay", playWhenReady);
                        const s = readSettings();
                        video.loop = s.loop;
                        video.playbackRate = s.speed;
                        video.volume = s.volume;
                        video.muted = s.muted;
                        // `autoplay` here means "this is a freshly finished
                        // generation, not a restore of a previously-viewed
                        // video" — whether it actually plays is gated by the
                        // user's autoplay toggle.
                        if (autoplay && s.autoplay) {
                            video.play().catch(() => {});
                        }
                    };
                    video.addEventListener("canplay", playWhenReady);
                    video.load();
                }

                setCompareMode(!!b);
                if (b) {
                    videoB.src = "/video_player/stream?path=" + encodeURIComponent(b);
                    videoB.load();
                }
            }

            node.videoPlayerLoad = loadPaths;

            const lastPaths = readLastPaths();
            if (lastPaths.a || lastPaths.b) loadPaths(lastPaths);

            const domWidget = node.addDOMWidget("video_player_widget", "videoplayer", container, {
                serialize: false,
            });

            // Previous approach: computeSize derived its answer from a
            // mutable cache (_videoPlayerHeight), and onResize wrote the
            // resulting size back into that same cache. ANY two-way
            // coupling like that can drift and compound over repeated
            // layout passes, no matter how well the overhead is measured/
            // calibrated — especially since newer ComfyUI frontends can
            // call computeSize on every render tick, not just on explicit
            // resize events. That's what caused the node to visibly grow
            // by itself, non-stop.
            //
            // Fix: break the loop by construction. computeSize now returns
            // a fixed constant minimum height, never derived from the
            // node's current size or any value we update elsewhere. There
            // is nothing for onResize to feed back into, so there is no
            // path left for a loop to form. The node can still be resized
            // normally by the user (dragging the corner) — LiteGraph's own
            // resize handling takes care of that independently, and the
            // DOM widget fills whichever size the node ends up at via CSS
            // (height: 100% on the container), not via JS recomputation.
            const MIN_WIDGET_HEIGHT = 260;
            const MIN_WIDGET_WIDTH = 280;

            domWidget.computeSize = function (width) {
                return [width || MIN_WIDGET_WIDTH, MIN_WIDGET_HEIGHT];
            };

            if (node.size[0] < 340) node.size[0] = 340;
            if (node.size[1] < 320) node.size[1] = 320;

            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const r = onExecuted ? onExecuted.apply(this, arguments) : undefined;
            if (message && (message.video_path_a || message.video_path_b)) {
                const pA = message.video_path_a ? message.video_path_a[0] : "";
                const pB = message.video_path_b ? message.video_path_b[0] : "";
                if (this.videoPlayerLoad) this.videoPlayerLoad({ a: pA, b: pB }, true);
                try {
                    localStorage.setItem("videoPlayerPathA_" + this.id, pA || "");
                    localStorage.setItem("videoPlayerPathB_" + this.id, pB || "");
                } catch (e) {}
            }
            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            let pA = "", pB = "";
            try {
                pA = localStorage.getItem("videoPlayerPathA_" + this.id) || "";
                pB = localStorage.getItem("videoPlayerPathB_" + this.id) || "";
            } catch (e) {}
            if ((pA || pB) && this.videoPlayerLoad) {
                this.videoPlayerLoad({ a: pA, b: pB });
            }
            return r;
        };
    },
});
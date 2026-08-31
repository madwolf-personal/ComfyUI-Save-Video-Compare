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
        if (!detail || !detail.output || !detail.output.video_path) return;
        const p = detail.output.video_path[0];
        if (p === undefined) return;
        try {
            localStorage.setItem("videoPlayerPath_" + detail.node, p || "");
        } catch (e) {}
        // Update the live node wherever it's mounted — active tab or not.
        const liveNode = mountedVideoPlayerNodes.get(detail.node);
        if (liveNode && liveNode.videoPlayerLoad) {
            liveNode.videoPlayerLoad(p, true);
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
            // last played path in localStorage, keyed by this node's id,
            // so they survive tab switches without needing a visible
            // (or hidden, which is buggy) video_path widget.
            const settingsKey = "videoPlayerSettings_" + node.id;
            const pathKey = "videoPlayerPath_" + node.id;

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
            function readLastPath() {
                try {
                    return localStorage.getItem(pathKey) || "";
                } catch (e) {
                    return "";
                }
            }
            function writeLastPath(p) {
                try {
                    localStorage.setItem(pathKey, p || "");
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

            const video = document.createElement("video");
            video.style.width = "100%";
            video.style.height = "100%";
            video.style.flex = "1 1 0";
            video.style.minHeight = "0";
            video.style.display = "block";
            video.style.background = "#000";
            video.style.objectFit = "contain";
            video.preload = "metadata";
            video.playsInline = true;
            container.appendChild(video);

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

            playBtn.onclick = () => {
                if (video.paused) video.play();
                else video.pause();
            };
            video.addEventListener("play", () => (playBtn.textContent = "\u23F8"));
            video.addEventListener("pause", () => (playBtn.textContent = "\u25B6"));
            video.addEventListener("ended", () => (playBtn.textContent = "\u25B6"));
            video.style.cursor = "pointer";
            video.addEventListener("click", () => {
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

            seek.addEventListener("input", () => {
                seeking = true;
                if (video.duration) {
                    video.currentTime = (seek.value / 1000) * video.duration;
                }
            });
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

            function stepFrame(direction) {
                video.pause();
                const duration = isFinite(video.duration) ? video.duration : Infinity;
                let t = video.currentTime + direction * FRAME_STEP;
                t = Math.min(Math.max(t, 0), duration);
                video.currentTime = t;
            }

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

            function loadPath(p, autoplay = false) {
                p = stripQuotes(p);
                if (!p) {
                    video.removeAttribute("src");
                    dimsLabel.textContent = "";
                    return;
                }
                video.src = "/video_player/stream?path=" + encodeURIComponent(p);
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

            node.videoPlayerLoad = loadPath;

            const lastPath = readLastPath();
            if (lastPath) loadPath(lastPath);

            const domWidget = node.addDOMWidget("video_player_widget", "videoplayer", container, {
                serialize: false,
            });

            const RESERVED = 60; // title bar + margins (no video_path widget anymore)

            // IMPORTANT: computeSize must NOT read node.size[1] to derive its
            // return value. LiteGraph uses the widget's computed size (plus
            // its own internal padding) to decide the node's *minimum*
            // required height on every layout pass, and grows the node if
            // needed. If we feed node.size[1] back into that calculation,
            // any padding LiteGraph adds gets baked into node.size[1]
            // permanently, and the next layout pass grows it again — a
            // feedback loop that compounds every time layout runs (e.g. on
            // every tab switch, which forces a redraw/layout in ComfyUI).
            // Instead we track the node's height ourselves, only updating
            // our cached value when the user actually resizes the node.
            node._videoPlayerHeight = Math.max(node.size[1] || 320, 320);

            domWidget.computeSize = function (width) {
                const w = width || node.size[0];
                const h = Math.max(node._videoPlayerHeight - RESERVED, 120);
                return [w, h];
            };

            const onResize = node.onResize;
            node.onResize = function (size) {
                if (onResize) onResize.apply(this, arguments);
                // Cache the height from this explicit resize event only —
                // never from a read of node.size[1] inside computeSize.
                node._videoPlayerHeight = Math.max(size[1], 320);
                node.setDirtyCanvas(true, true);
            };

            node.setSize([Math.max(node.size[0], 340), Math.max(node.size[1], 320)]);
            node._videoPlayerHeight = Math.max(node.size[1], 320);

            return r;
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            const r = onExecuted ? onExecuted.apply(this, arguments) : undefined;
            if (message && message.video_path && message.video_path[0] !== undefined) {
                const p = message.video_path[0];
                if (this.videoPlayerLoad) this.videoPlayerLoad(p, true);
                try {
                    localStorage.setItem("videoPlayerPath_" + this.id, p || "");
                } catch (e) {}
            }
            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
            let lastPath = "";
            try {
                lastPath = localStorage.getItem("videoPlayerPath_" + this.id) || "";
            } catch (e) {}
            if (lastPath && this.videoPlayerLoad) {
                this.videoPlayerLoad(lastPath);
            }
            return r;
        };
    },
});
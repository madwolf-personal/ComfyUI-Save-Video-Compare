# ComfyUI Video Player / Compare Node

### Not really all features covered but Watch the video if you want: 
https://github.com/madwolf-personal/ComfyUI-Save-Video-Compare/blob/main/assets/Video%20Player.mp4

<img width="1367" height="901" alt="image" src="https://github.com/user-attachments/assets/bed3fd44-558a-481a-a935-f9466634a222" />


A custom ComfyUI node that plays back one or two generated/loaded videos
directly on the node itself. With one video connected it's a full-featured
player; with two connected it becomes an A/B swipe comparison, with
playback controls and keyboard shortcuts either way — no need to open the
output folder or a separate viewer.

## What it does

`VideoPlayerNode` sits at the end of your workflow (it's an output node) and:

1. Accepts a `video_a` input (required) and an optional `video_b` input —
   both `VIDEO` type, e.g. from a video-generation or video-loading node —
   plus an `a_save_name` and `b_save_name` string for each one's filename
   prefix.
2. Saves whichever of A/B is connected to disk under ComfyUI's output
   directory using the same naming convention as other save nodes
   (`prefix_00001_.mp4`, incrementing), using each video's own save name.
3. Outputs `video_a` and `video_b` passed straight through as `VIDEO`
   outputs — the same pattern ComfyUI's own `SaveImage`/`SaveVideo` nodes
   use — so you can chain further nodes off this one instead of re-wiring
   back to the original source(s).
4. **Single mode** (only `video_a` connected): behaves exactly like a plain
   video player — one `<video>` element and the full transport bar, nothing
   else.
5. **Compare mode** (both `video_a` and `video_b` connected): overlays B on
   top of A with a swipe divider you drag via a slider — everything to the
   left of the divider shows B, everything to the right shows A. A/B labels
   appear in the corners. Play/pause/seek/speed/loop on the transport bar
   drive video A; video B silently mirrors A's playback state (play, pause,
   rate, and loop) and gets nudged back in sync if it drifts more than
   ~150ms, since two independently-decoding `<video>` elements can't be
   perfectly locked together. B is always muted so you don't get doubled
   audio.
6. Automatically loads whichever video(s) just finished generating, plays
   the single-mode video if the autoplay toggle is on, and remembers the
   last-played path(s) and your control settings (loop, speed, volume,
   mute, autoplay) across page reloads / tab switches. The compare
   slider's position itself isn't persisted — it always starts centered.

**Only two connection patterns are supported**: `video_a` alone, or
`video_a` **and** `video_b`. `video_b` alone (with `video_a`
disconnected) isn't valid — `video_a` is the node's required input, so if
you only have one video to view, connect it there.

## How it works

### Backend (`nodes.py`)
- A shared `_save_video()` helper writes a video to
  `ComfyUI/output/<save_name>_<counter>_.mp4` using
  `folder_paths.get_save_image_path`, called once for A and, if connected,
  once more for B (with its own save name and counter sequence).
- `VideoPlayerNode.execute()` calls that helper for whichever of A/B are
  present, returns both videos passed straight through as outputs, and
  sends the saved path(s) via the `ui` payload so the frontend can pick
  them up immediately after execution. The `ui` payload only includes a
  `video_path_b` entry when B was actually connected — that's how the
  frontend tells "no B this run" apart from "B saved to an empty-string
  path", and it's what triggers single-mode vs. compare-mode rendering.

### Backend (`__init__.py`)
- Registers an HTTP route, `GET /video_player/stream`, that serves a saved
  video file to the browser (used for both A and B — it just takes a
  `path` query parameter, so it doesn't need to know which one it's
  serving).
- Supports HTTP `Range` requests (206 Partial Content), which is what lets
  the `<video>` elements seek instantly instead of downloading the whole
  file first.
- Gracefully handles the client aborting an in-progress stream (seeking,
  reloading the page, closing the tab) by catching the resulting
  connection errors instead of letting them surface as unhandled server
  tracebacks.

### Frontend (`js/video_player.js`)
- Registers a ComfyUI extension that hooks into `VideoPlayerNode`'s
  lifecycle (`onNodeCreated`, `onExecuted`, `onConfigure`) to build and
  manage a DOM widget containing the `<video>` element(s), compare overlay,
  and control bar.
- On every workflow execution, reads whichever of `video_path_a` /
  `video_path_b` the node returned and points the corresponding `<video>`
  element at `/video_player/stream?path=<that path>`, switching into
  compare mode only when a B path is present.
- Persists the last played A/B paths and your control preferences (loop /
  speed / volume / muted / autoplay) in `localStorage`, keyed by the
  node's id, so reopening or reloading the graph restores playback state
  without needing visible path widgets on the node.
- Also listens for `executed` events globally via the websocket API client,
  not just the node's own `onExecuted` hook. This keeps the cached path(s)
  and live player in sync even if a run finishes while you're on a
  different workflow tab, since `onExecuted` is only delivered to nodes in
  the currently active graph — the listener looks up mounted node
  instances through a module-level registry (populated in `onNodeCreated`,
  cleaned up in `onRemoved`) instead of `app.graph`, which only reflects
  whichever tab is currently active.
- **Sizing**: the DOM widget's `computeSize` always returns a fixed
  constant `[width, 260]`, regardless of node state (single vs. compare
  mode, video loaded or not). Nothing feeds a measured or cached value back
  into it, so there's no path for a resize feedback loop to form — the
  node can still be resized normally by dragging its corner, and the
  player fills whatever size the node ends up at via CSS, not JS
  recomputation. This holds in compare mode too: the extra slider row just
  takes space from the flexbox layout inside the fixed-height widget, it
  doesn't change `computeSize`'s answer.

## Controls

The control bar under the video gives you:

| Control | Action |
|---|---|
| ▶ / ⏸ button | Play / pause (drives video A; B mirrors it) |
| Time label | Current time / total duration (video A) |
| Seek bar | Drag to scrub to any point in the video |
| `loop:on` / `loop:off` button | Toggle looping |
| Speed dropdown | `0.25x` – `2x` playback speed |
| 🔊 / 🔇 button | Mute / unmute (video A only — B is always muted) |
| Volume slider | Adjust volume (0–1) |
| ⛶ button | Toggle fullscreen |
| `auto:on` / `auto:off` button | Toggle autoplay for freshly generated videos |
| Resolution label | Shows video A's width × height |

Compare mode (both A and B connected) additionally shows A/B corner labels
and a draggable divider line. There's no separate slider control — press
and drag **on the white divider line itself** to move it (the cursor
changes to `↔` within a few pixels of the line); a click anywhere else on
the video still toggles play/pause as usual.

Clicking the video itself also toggles play/pause, and double-clicking
toggles fullscreen. The autoplay toggle only affects videos that just
finished generating (a fresh `onExecuted` result) — it does **not**
autoplay a video you're restoring from a previous session on page
load/tab switch. The resolution label fills in once the browser has read
video A's metadata, and updates automatically every time a new video A
loads.

## Keyboard Shortcuts

Shortcuts only activate while your cursor is **hovering over the player**
(not fullscreen-only — they work in both normal and fullscreen mode), and
are ignored while you're typing in a text field elsewhere in ComfyUI. This
keeps them from clashing with ComfyUI's own canvas shortcuts (e.g. Space for
hand-tool, `.` for fit-to-view, `M` for the models panel) when your cursor
isn't over the player.

| Key | Action |
|---|---|
| `F` | Toggle fullscreen |
| `Space` | Play / pause |
| `M` | Mute / unmute |
| `L` | Toggle loop on/off |
| `A` | Toggle autoplay on/off |
| `N` | Step forward 1 frame (pauses if playing) |
| `B` | Step backward 1 frame (pauses if playing) |
| `,` | Step playback speed down |
| `.` | Step playback speed up |
| `/` | Reset playback speed to 1x |

**Frame stepping:** `N`/`B` pause the video (if it's currently playing) and
nudge `currentTime` by ~1/30s. HTML5 `<video>` has no reliable cross-browser
way to query a source's actual frame rate or step to an exact frame
boundary, so this is an approximation — a small, consistent step rather
than a guaranteed exact frame, and closest to accurate for ~30fps sources.
In compare mode, `N`/`B` step video A; video B follows via the same sync
logic that keeps it matched to A during normal playback.

**Loop behavior:** if you turn loop on while the video is paused at (or
very near) the end, it automatically restarts and resumes playback right
away — you don't need to press play or Space separately.

## Files

- `nodes.py` — node definition, dual-input schema, and video-saving logic.
- `__init__.py` — registers the node's Python package and the video
  streaming HTTP route.
- `js/video_player.js` — frontend extension: builds the player/compare UI,
  wires up controls and keyboard shortcuts, and syncs playback state with
  the node.

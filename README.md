# ComfyUI Video Player Node
<img width="1042" height="885" alt="image" src="https://github.com/user-attachments/assets/fed45374-a957-4c27-abe0-b3290062b149" />

A custom ComfyUI node that plays back a generated/loaded video directly on the
node itself, with a full set of playback controls and keyboard shortcuts —
no need to open the output folder or a separate viewer.

## What it does

`VideoPlayerNode` sits at the end of your workflow (it's an output node) and:

1. Accepts a `video` input (a `VIDEO` type, e.g. from a video-generation or
   video-loading node) and a `filename_prefix` string.
2. Saves the video to disk under ComfyUI's output directory using the same
   naming convention as other save nodes (`prefix_00001_.mp4`, incrementing).
3. Outputs the saved file's path as a string, and passes the original
   `video` straight through as a `VIDEO` output — the same pattern ComfyUI's
   own `SaveImage`/`SaveVideo` nodes use — so you can chain further nodes
   off this one instead of re-wiring back to the original source.
4. Streams that saved file back into an embedded `<video>` player rendered
   right on the node, with its own transport bar (play/pause, seek, loop,
   speed, volume/mute, fullscreen).
5. Automatically loads the new video every time the workflow runs, plays it
   if the autoplay toggle is on, and remembers the last-played file and
   your control settings (loop, speed, volume, mute, autoplay) across page
   reloads / tab switches.

## How it works

### Backend (`nodes.py`)
- `VideoPlayerNode.execute()` writes the incoming video to
  `ComfyUI/output/<filename_prefix>_<counter>_.mp4` using
  `folder_paths.get_save_image_path`, then returns two outputs: the saved
  path as a `video_path` string, and the original `video` object passed
  straight through as a `video` output. It also sends the path via the
  `ui` payload so the frontend widget can pick it up immediately after
  execution. The passthrough output means you don't need a separate branch
  back to the original video source if you want to keep processing it
  after saving/previewing.

### Backend (`__init__.py`)
- Registers an HTTP route, `GET /video_player/stream`, that serves the saved
  video file to the browser.
- Supports HTTP `Range` requests (206 Partial Content), which is what lets
  the `<video>` element seek instantly instead of downloading the whole file
  first.
- Gracefully handles the client aborting an in-progress stream (seeking,
  reloading the page, closing the tab) by catching the resulting
  connection errors instead of letting them surface as unhandled server
  tracebacks.

### Frontend (`js/video_player.js`)
- Registers a ComfyUI extension that hooks into `VideoPlayerNode`'s
  lifecycle (`onNodeCreated`, `onExecuted`, `onConfigure`) to build and
  manage a DOM widget containing the `<video>` element and control bar.
- On every workflow execution, reads the `video_path` returned by the node
  and points the `<video>` element at
  `/video_player/stream?path=<that path>`, then autoplays it if the
  autoplay toggle is on.
- Persists the last played path and your control preferences (loop / speed
  / volume / muted / autoplay) in `localStorage`, keyed by the node's ID, so
  reopening or reloading the graph restores playback state without needing
  a visible path widget on the node.
- Also listens for `executed` events globally via the websocket API client,
  not just the node's own `onExecuted` hook. This keeps the cached path and
  live player in sync even if a run finishes while you're on a different
  workflow tab, since `onExecuted` is only delivered to nodes in the
  currently active graph.

## Controls

The control bar under the video gives you:

| Control | Action |
|---|---|
| ▶ / ⏸ button | Play / pause |
| Time label | Current time / total duration |
| Seek bar | Drag to scrub to any point in the video |
| `loop:on` / `loop:off` button | Toggle looping |
| Speed dropdown | `0.25x` – `2x` playback speed |
| 🔊 / 🔇 button | Mute / unmute |
| Volume slider | Adjust volume (0–1) |
| ⛶ button | Toggle fullscreen |
| `auto:on` / `auto:off` button | Toggle autoplay for freshly generated videos |
| Resolution label | Shows the loaded video's width × height |

Clicking the video itself also toggles play/pause, and double-clicking
toggles fullscreen.

The autoplay toggle only affects videos that just finished generating (a
fresh `onExecuted` result) — it does **not** autoplay a video you're
restoring from a previous session on page load/tab switch. The resolution
label fills in once the browser has read the video's metadata, and updates
automatically every time a new video loads.

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

**Loop behavior:** if you turn loop on while the video is paused at (or
very near) the end, it automatically restarts and resumes playback right
away — you don't need to press play or Space separately.

## Files

- `nodes.py` — node definition and video-saving logic.
- `__init__.py` — registers the node's Python package and the video
  streaming HTTP route.
- `js/video_player.js` — frontend extension: builds the player UI, wires up
  controls and keyboard shortcuts, and syncs playback state with the node.

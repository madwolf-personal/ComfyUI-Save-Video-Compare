import os

import folder_paths
from comfy.cli_args import args
from comfy_api.latest import ComfyExtension, io


def _save_video(video, filename_prefix, prompt, extra_pnginfo):
    full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(
        filename_prefix, folder_paths.get_output_directory()
    )
    os.makedirs(full_output_folder, exist_ok=True)
    file = f"{filename}_{counter:05}_.mp4"
    path = os.path.join(full_output_folder, file)

    # video.save_to() (comfy_api.latest._input_impl.video_types) does NOT
    # accept prompt=/extra_pnginfo= kwargs directly -- it takes a single
    # `metadata: Optional[dict] = None` argument, and internally it does
    # `output.metadata[key] = json.dumps(value)` for every entry itself.
    # That means we must pass the RAW prompt/extra_pnginfo objects here,
    # NOT pre-serialized JSON strings (unlike core's SaveLatent, which
    # writes to safetensors metadata and therefore needs pre-dumped
    # strings). Pre-dumping here would double-encode the value, writing
    # an escaped JSON *string* into the container tag instead of a
    # parseable JSON *object* -- which is exactly why ComfyUI couldn't
    # reload the workflow when the .mp4 was dragged back in.
    metadata = None
    if not args.disable_metadata:
        metadata = {}
        if prompt is not None:
            metadata["prompt"] = prompt
        if extra_pnginfo is not None:
            for key, value in extra_pnginfo.items():
                metadata[key] = value

    video.save_to(path, metadata=metadata)
    return path


class VideoPlayerNode(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="VideoPlayerNode",
            display_name="Video Player / Compare",
            category="video",
            inputs=[
                io.Video.Input("video_a"),
                io.String.Input("a_save_name", default="video/A"),
                io.Video.Input("video_b", optional=True),
                io.String.Input("b_save_name", default="video/B"),
            ],
            hidden=[
                io.Hidden.prompt,
                io.Hidden.extra_pnginfo,
            ],
            outputs=[
                io.Video.Output(display_name="video_a"),
                io.Video.Output(display_name="video_b"),
            ],
            is_output_node=True,
        )

    @classmethod
    def execute(
        cls,
        video_a,
        a_save_name: str = "video/A",
        video_b=None,
        b_save_name: str = "video/B",
    ) -> io.NodeOutput:
        hidden = getattr(cls, "hidden", None)
        prompt = getattr(hidden, "prompt", None) if hidden else None
        extra_pnginfo = getattr(hidden, "extra_pnginfo", None) if hidden else None

        path_a = _save_video(video_a, a_save_name, prompt, extra_pnginfo)
        path_b = None
        if video_b is not None:
            path_b = _save_video(video_b, b_save_name, prompt, extra_pnginfo)

        ui = {"video_path_a": [path_a]}
        # Only send a video_path_b entry when there actually is a B video --
        # an empty/missing key (rather than a key with an empty string) is
        # how the frontend tells "no B video this run" apart from "B video
        # saved to a path that happens to be falsy", and it's what lets it
        # know to fall back to single-player mode instead of compare mode.
        if path_b is not None:
            ui["video_path_b"] = [path_b]

        return io.NodeOutput(video_a, video_b, ui=ui)


class VideoPlayerExtension(ComfyExtension):
    async def get_node_list(self):
        return [VideoPlayerNode]


async def comfy_entrypoint() -> VideoPlayerExtension:
    return VideoPlayerExtension()

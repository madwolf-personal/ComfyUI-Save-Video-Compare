import os

import folder_paths
from comfy_api.latest import ComfyExtension, io


class VideoPlayerNode(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="VideoPlayerNode",
            display_name="Video Player",
            category="video",
            inputs=[
                io.Video.Input("video"),
                io.String.Input("filename_prefix", default="video/ComfyUI"),
            ],
            outputs=[
                io.String.Output(display_name="video_path"),
            ],
            is_output_node=True,
        )

    @classmethod
    def execute(cls, video, filename_prefix: str = "video/ComfyUI") -> io.NodeOutput:
        full_output_folder, filename, counter, subfolder, filename_prefix = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory()
        )
        os.makedirs(full_output_folder, exist_ok=True)
        file = f"{filename}_{counter:05}_.mp4"
        path = os.path.join(full_output_folder, file)
        video.save_to(path)

        return io.NodeOutput(path, ui={"video_path": [path]})


class VideoPlayerExtension(ComfyExtension):
    async def get_node_list(self):
        return [VideoPlayerNode]


async def comfy_entrypoint() -> VideoPlayerExtension:
    return VideoPlayerExtension()

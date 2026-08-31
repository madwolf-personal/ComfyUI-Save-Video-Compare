import os
import mimetypes
import asyncio
from aiohttp import web
import server

from .nodes import comfy_entrypoint

WEB_DIRECTORY = "./js"

routes = server.PromptServer.instance.routes


@routes.get("/video_player/stream")
async def video_player_stream(request):
    path = request.rel_url.query.get("path", "")
    if not path or not os.path.isfile(path):
        return web.Response(status=404, text="File not found")

    file_size = os.path.getsize(path)
    content_type = mimetypes.guess_type(path)[0] or "video/mp4"
    range_header = request.headers.get("Range")

    if range_header:
        range_val = range_header.strip().split("=")[-1]
        start_str, end_str = (range_val.split("-") + [""])[:2]
        start = int(start_str) if start_str else 0
        end = int(end_str) if end_str else file_size - 1
        end = min(end, file_size - 1)
        chunk_size = end - start + 1

        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(chunk_size),
            "Content-Type": content_type,
        }
        resp = web.StreamResponse(status=206, headers=headers)
        await resp.prepare(request)
        try:
            with open(path, "rb") as f:
                f.seek(start)
                remaining = chunk_size
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    await resp.write(chunk)
                    remaining -= len(chunk)
        except (ConnectionResetError, ConnectionError, asyncio.CancelledError):
            # Client aborted the request (seek/reload/tab close) while we
            # were still writing — nothing to do, just stop streaming.
            pass
        return resp

    headers = {
        "Content-Length": str(file_size),
        "Content-Type": content_type,
        "Accept-Ranges": "bytes",
    }
    resp = web.StreamResponse(status=200, headers=headers)
    await resp.prepare(request)
    try:
        with open(path, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                await resp.write(chunk)
    except (ConnectionResetError, ConnectionError, asyncio.CancelledError):
        pass
    return resp


__all__ = ["comfy_entrypoint", "WEB_DIRECTORY"]

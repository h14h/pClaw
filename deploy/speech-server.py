"""Speech to text for pclaw: Parakeet through mlx-audio, on Apple's GPU.

    POST /v1/transcribe  raw audio in any format ffmpeg reads  ->  {"text": ..., "seconds": ..., "ms": ...}
    GET  /health         200 once the model is loaded

    python -I speech-server.py --port 8086

Long audio has to be chunked: unchunked, Parakeet silently drops most of a ten-minute file.
"""

import argparse
import json
import os
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mlx_audio.stt.utils import load_model

parser = argparse.ArgumentParser()
parser.add_argument("--model", default="mlx-community/parakeet-tdt-0.6b-v3")
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=8086)
args = parser.parse_args()

MAX_BYTES = 100 * 1024 * 1024
model = load_model(args.model)
lock = threading.Lock()


def transcribe(audio):
    with tempfile.TemporaryDirectory() as folder:
        source = os.path.join(folder, "in")
        wav = os.path.join(folder, "in.wav")
        with open(source, "wb") as f:
            f.write(audio)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", source, "-ar", "16000", "-ac", "1", wav], check=True)
        seconds = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav]).strip())
        started = time.perf_counter()
        with lock:
            result = model.generate(wav, chunk_duration=60.0, overlap_duration=10.0)
    return {"text": result.text.strip(), "seconds": seconds, "ms": round((time.perf_counter() - started) * 1000)}


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply(200 if self.path == "/health" else 404, {"ok": self.path == "/health"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        if self.path != "/v1/transcribe" or length == 0 or length > MAX_BYTES:
            self.reply(400, {"error": "POST audio to /v1/transcribe"})
            return
        try:
            self.reply(200, transcribe(self.rfile.read(length)))
        except Exception as error:
            self.reply(500, {"error": str(error)})

    def log_message(self, format, *values):
        pass


print(f"{args.model} on http://{args.host}:{args.port}", flush=True)
ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()

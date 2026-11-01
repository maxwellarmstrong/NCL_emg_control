"""Local-only acquisition API. Raw EMG and landmarks stay on this machine."""
import argparse
import copy
import json
import os
import threading
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .signal import FilterConfig

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("EMG_DATA_DIR", ROOT / "data" / "sessions"))
app = FastAPI(title="EMG Acquisition Lab", version="0.1.0")
lock = threading.RLock()
active = {}


@app.middleware("http")
async def local_asset_cache(request, call_next):
    response = await call_next(request)
    if request.url.path.startswith('/assets/'):
        response.headers['Cache-Control'] = 'no-cache'
    return response


class SessionConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    source: str = "synthetic"
    sample_rate_hz: int = 250
    participant: str = Field(default="p01", max_length=80, min_length=1)
    split: str = "train"
    wiring: str = "bipolar"
    mains_hz: int = 60
    hand: str = "Right"
    label_delay_ms: float = Field(default=0, ge=-500, le=500)
    client_time_origin_ms: float = 0
    notes: str = Field(default="", max_length=2000)

    @field_validator("source")
    @classmethod
    def source_valid(cls, v):
        if v not in ("synthetic", "cyton"):
            raise ValueError("Unknown acquisition source")
        return v

    @field_validator("split")
    @classmethod
    def split_valid(cls, v):
        if v not in ("train", "val", "test"):
            raise ValueError("Split must be train, val, or test")
        return v

    @field_validator("wiring")
    @classmethod
    def wiring_valid(cls, v):
        if v not in ("bipolar", "common"):
            raise ValueError("Unknown electrode wiring")
        return v

    @field_validator("hand")
    @classmethod
    def hand_valid(cls, v):
        if v not in ("Right", "Left"):
            raise ValueError("Choose Right or Left")
        return v


class Sample(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    index: int = Field(ge=0)
    t_ms: float = Field(ge=0)
    received_ms: float = Field(ge=0)
    sequence: int = Field(ge=0, le=255)
    uv: list[float] = Field(min_length=8, max_length=8)
    counts: list[int] | None = Field(default=None, min_length=8, max_length=8)
    aux: list[int] | None = Field(default=None, min_length=6, max_length=6)
    footer: int | None = None
    clipped: bool = False
    timing_uncertain: bool = False


class Vision(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    t_ms: float = Field(ge=0)
    processed_ms: float = Field(ge=0)
    valid: bool
    reason: str = Field(max_length=200)
    flexion: list[float] | None = Field(default=None, min_length=5, max_length=5)
    angles: list[float] | None = Field(default=None, min_length=5, max_length=5)
    landmarks: list[list[float]] | None = None
    world_landmarks: list[list[float]] | None = None
    handedness_score: float | None = Field(default=None, ge=0, le=1)
    media_time_s: float | None = None

    @field_validator("flexion")
    @classmethod
    def bounded(cls, v):
        if v is not None and any(x < 0 or x > 1 for x in v):
            raise ValueError("Flexion must be in [0,1]")
        return v


class Batch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    batch_id: int = Field(ge=0)
    emg: list[Sample] = Field(default_factory=list, max_length=2000)
    vision: list[Vision] = Field(default_factory=list, max_length=120)
    events: list[dict] = Field(default_factory=list, max_length=100)


def session_path(session_id):
    try:
        if str(uuid.UUID(session_id)) != session_id:
            raise ValueError()
    except ValueError:
        raise HTTPException(400, "Invalid session ID")
    return DATA / session_id


def save_metadata(path, meta):
    temp = path / "metadata.tmp"
    temp.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    temp.replace(path / "metadata.json")


@app.get("/api/health")
def health():
    return {"ok": True, "data_directory": str(DATA), "camera_model_ready": (ROOT / "models/hand_landmarker.task").exists(),
            "mediapipe_ready": (ROOT / "node_modules/@mediapipe/tasks-vision/vision_bundle.mjs").exists()}


@app.get("/api/filter")
def filter_profile(rate: int = 250, mains: int = 60):
    try:
        return FilterConfig.for_rate(rate, mains).describe()
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.post("/api/sessions")
def create_session(config: SessionConfig):
    if config.source == "cyton" and config.sample_rate_hz != 250:
        raise HTTPException(422, "Cyton USB radio supports 250 Hz only")
    try:
        profile = FilterConfig.for_rate(config.sample_rate_hz, config.mains_hz).describe()
    except ValueError as e:
        raise HTTPException(422, str(e))
    session_id = str(uuid.uuid4())
    path = session_path(session_id)
    path.mkdir(parents=True)
    meta = {"schema_version": 1, "id": session_id, "created_utc": datetime.now(timezone.utc).isoformat(),
            "status": "recording", "config": config.model_dump(), "filter": profile,
            "timestamps": "Browser monotonic milliseconds. EMG sample-count reconstructed; camera callback time. Not hardware synchronized.",
            "video_saved": False, "counts": {"emg": 0, "vision": 0, "events": 0}, "last_batch_id": -1}
    with lock:
        save_metadata(path, meta)
        active[session_id] = {"meta": meta, "last_index": -1, "last_t": -1., "last_vision_t": -1.}
    return {"id": session_id, "metadata": meta}


@app.post("/api/sessions/{session_id}/batch")
def append_batch(session_id: str, batch: Batch):
    path = session_path(session_id)
    with lock:
        state = active.get(session_id)
        if state is None:
            raise HTTPException(409, "Recording is closed or server restarted; start a new session")
        meta = state["meta"]
        if batch.batch_id <= meta["last_batch_id"]:
            return {"ack": batch.batch_id, "duplicate": True, "counts": meta["counts"]}
        if batch.batch_id != meta["last_batch_id"] + 1:
            raise HTTPException(409, "Out-of-order batch")
        indices = [state["last_index"]] + [s.index for s in batch.emg]
        times = [state["last_t"]] + [s.t_ms for s in batch.emg]
        vt = [state["last_vision_t"]] + [v.t_ms for v in batch.vision]
        if any(b <= a for values in (indices, times, vt) for a, b in zip(values, values[1:])):
            raise HTTPException(422, "Samples and frames must be strictly ordered")
        if any(v.valid and v.flexion is None for v in batch.vision):
            raise HTTPException(422, "Valid vision labels require calibrated flexion")
        payloads = {}
        next_meta = copy.deepcopy(meta)
        for name in ("emg", "vision", "events"):
            rows = getattr(batch, name)
            if rows:
                try:
                    payloads[name] = ''.join(json.dumps(row.model_dump() if isinstance(row, BaseModel) else row,
                        separators=(",", ":"), allow_nan=False) + "\n" for row in rows).encode('utf-8')
                except (ValueError, TypeError) as e:
                    raise HTTPException(422, "Invalid recording payload") from e
                next_meta["counts"][name] += len(rows)
        next_meta["last_batch_id"] = batch.batch_id
        streams = []
        try:
            # Retain file offsets until metadata commits. A retry after a recoverable
            # write failure must not duplicate already appended samples.
            for name, payload in payloads.items():
                stream = (path / f"{name}.jsonl").open("a+b")
                streams.append((stream, stream.tell()))
                stream.write(payload)
                stream.flush()
            save_metadata(path, next_meta)
        except OSError as e:
            rollback_failed = False
            for stream, offset in streams:
                try:
                    stream.truncate(offset)
                    stream.flush()
                except OSError:
                    rollback_failed = True
            if rollback_failed:
                active.pop(session_id, None)  # Fail closed; export as interrupted.
            raise HTTPException(503, "Local write failed; check available disk space and retry" if not rollback_failed
                else "Storage failure interrupted this session; export it and start a new recording") from e
        finally:
            for stream, _ in streams:
                stream.close()
        state.update(meta=next_meta, last_index=indices[-1], last_t=times[-1], last_vision_t=vt[-1])
        return {"ack": batch.batch_id, "counts": next_meta["counts"]}


@app.post("/api/sessions/{session_id}/stop")
def stop_session(session_id: str):
    path = session_path(session_id)
    with lock:
        state = active.get(session_id)
        if state is None:
            if (path / "metadata.json").exists():
                meta = json.loads((path / "metadata.json").read_text(encoding="utf-8"))
                if meta["status"] == "complete":
                    return meta  # Finalization response may have been lost in transit.
            raise HTTPException(409, "No active recording")
        meta = copy.deepcopy(state["meta"])
        meta.update(status="complete", stopped_utc=datetime.now(timezone.utc).isoformat())
        save_metadata(path, meta)
        active.pop(session_id)
    return meta


@app.get("/api/sessions")
def list_sessions():
    sessions = []
    with lock:
        for p in sorted(DATA.glob("*/metadata.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:100]:
            meta = json.loads(p.read_text(encoding="utf-8"))
            if meta["status"] == "recording" and meta["id"] not in active:
                meta["status"] = "interrupted"
            sessions.append({k: meta[k] for k in ("id", "created_utc", "status", "config", "counts")})
    return sessions


@app.get("/api/sessions/{session_id}/export")
def export_session(session_id: str):
    path = session_path(session_id)
    if not (path / "metadata.json").exists():
        raise HTTPException(404, "Session not found")
    if session_id in active:
        raise HTTPException(409, "Finish recording before export")
    # Spool to disk for long sessions rather than keeping a whole recording in RAM.
    import tempfile
    from starlette.background import BackgroundTask
    handle = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    handle.close()
    with zipfile.ZipFile(handle.name, "w", zipfile.ZIP_DEFLATED) as z:
        for name in ("metadata.json", "emg.jsonl", "vision.jsonl", "events.jsonl"):
            if (path / name).exists():
                z.write(path / name, arcname=f"{session_id}/{name}")
    return FileResponse(handle.name, filename=f"emg-{session_id}.zip", background=BackgroundTask(Path(handle.name).unlink))


@app.get("/api/model")
def model_status():
    return {"available": (ROOT / "artifacts/model.pt").exists(), "path": "artifacts/model.pt"}


class Prediction(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    sample_rate_hz: int
    mains_hz: int
    filtered_uv: list[list[float]] = Field(min_length=50, max_length=400)


@app.post("/api/predict")
def predict(request: Prediction):
    path = ROOT / "artifacts/model.pt"
    if not path.exists():
        raise HTTPException(404, "Train a model first")
    from .model import load_model
    import torch
    model, meta = load_model(path)
    from dataclasses import asdict
    try:
        expected = FilterConfig.for_rate(request.sample_rate_hz, request.mains_hz)
        expected.validate()
    except ValueError as e:
        raise HTTPException(422, str(e))
    if any(meta["filter"].get(key) != value for key, value in asdict(expected).items()):
        raise HTTPException(409, "Model filter profile does not match this stream")
    x = np.asarray(request.filtered_uv, dtype=np.float32)
    if x.shape != (meta["window_samples"], 8):
        raise HTTPException(422, "Wrong window shape")
    x = (x - np.asarray(meta["mean"])) / np.asarray(meta["std"])
    with torch.inference_mode():
        out = model(torch.tensor(x.T[None], dtype=torch.float32))
    return {"flexion": out["flexion"][0].tolist(), "active": out["active_logits"][0].sigmoid().tolist(),
            "training_source": meta["training_source"], "label_delay_ms": meta["label_delay_ms"]}


@app.get("/")
def index():
    return FileResponse(ROOT / "www/acquire/index.html", headers={"Cache-Control": "no-store"})


app.mount("/assets", StaticFiles(directory=ROOT / "www/acquire", check_dir=False), name="assets")
app.mount("/arm", StaticFiles(directory=ROOT / "www", html=True), name="arm")
app.mount("/vendor/mediapipe", StaticFiles(directory=ROOT / "node_modules/@mediapipe/tasks-vision", check_dir=False), name="mediapipe")
app.mount("/models", StaticFiles(directory=ROOT / "models", check_dir=False), name="models")


def main():
    import uvicorn
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8081)
    args = p.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()

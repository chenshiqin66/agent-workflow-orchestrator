"""HttpCallbackClient against a real mock HTTP callback server."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

from awo_executor.callback import HttpCallbackClient
from awo_executor.engine import run_job


class _Recorder(BaseHTTPRequestHandler):
    records: list[dict[str, Any]] = []

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            body = {"_raw": raw.decode("utf-8", errors="replace")}
        _Recorder.records.append(
            {
                "path": self.path,
                "token": self.headers.get("X-Executor-Token"),
                "body": body,
            }
        )
        self.send_response(201 if "/events" in self.path else 200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if "/events" in self.path:
            self.wfile.write(b'{"seq":1}')
        else:
            self.wfile.write(b'{"ok":true}')


@pytest.fixture()
def callback_server():
    _Recorder.records = []
    server = HTTPServer(("127.0.0.1", 0), _Recorder)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}", _Recorder
    server.shutdown()
    thread.join(timeout=2)


def test_http_callback_client_posts_status_and_event(callback_server):
    base, recorder = callback_server
    client = HttpCallbackClient(base, "tok-http")
    client.post_status("run_x", "running")
    client.post_event("run_x", "log", {"msg": "hi"}, node_id="n1")

    assert len(recorder.records) == 2
    assert recorder.records[0]["path"] == "/internal/runs/run_x/status"
    assert recorder.records[0]["token"] == "tok-http"
    assert recorder.records[0]["body"]["status"] == "running"
    assert recorder.records[1]["path"] == "/internal/runs/run_x/events"
    assert recorder.records[1]["body"]["event_type"] == "log"
    assert recorder.records[1]["body"]["node_id"] == "n1"


def test_engine_posts_over_http_to_mock_server(callback_server, job_payload):
    base, recorder = callback_server
    job = dict(job_payload)
    job["run_id"] = "run_http_engine"
    job["callback_base_url"] = base
    job["token"] = "tok-engine"

    client = HttpCallbackClient(base, "tok-engine")
    run_job(job, client)

    paths = [r["path"] for r in recorder.records]
    assert any(p.endswith("/status") for p in paths)
    assert any("/events" in p for p in paths)
    assert all(r["token"] == "tok-engine" for r in recorder.records)

    statuses = [
        r["body"].get("status")
        for r in recorder.records
        if r["path"].endswith("/status")
    ]
    assert "running" in statuses
    assert "succeeded" in statuses

    event_types = [
        r["body"].get("event_type")
        for r in recorder.records
        if "/events" in r["path"]
    ]
    assert "emit" in event_types
    assert event_types.count("node_finished") >= 5

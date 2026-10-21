from __future__ import annotations

import os
from unittest.mock import patch

from fastapi.testclient import TestClient

from awo_executor.main import app


def test_health():
    client = TestClient(app)
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"ok": True}


def test_jobs_rejects_bad_token(job_payload: dict):
    client = TestClient(app)
    with patch.dict(os.environ, {"EXECUTOR_TOKEN": "dev-token"}):
        res = client.post(
            "/v1/jobs",
            json=job_payload,
            headers={"X-Executor-Token": "wrong"},
        )
    assert res.status_code == 401


def test_jobs_accepts_and_returns_202(job_payload: dict):
    client = TestClient(app)

    class SyncThread:
        def __init__(self, *args, **kwargs):
            self._target = kwargs.get("target")
            self._args = kwargs.get("args") or ()

        def start(self):
            if self._target:
                self._target(*self._args)

    with patch.dict(os.environ, {"EXECUTOR_TOKEN": "dev-token"}):
        with patch("awo_executor.main.threading.Thread", side_effect=SyncThread):
            with patch("awo_executor.main.run_job") as mock_run:
                res = client.post(
                    "/v1/jobs",
                    json=job_payload,
                    headers={"X-Executor-Token": "dev-token"},
                )
                mock_run.assert_called_once()
    assert res.status_code == 202
    body = res.json()
    assert body["accepted"] is True
    assert body["run_id"] == "run_test_1"

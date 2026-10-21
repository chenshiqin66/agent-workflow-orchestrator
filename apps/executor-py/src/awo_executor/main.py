"""HTTP server: POST /v1/jobs, GET /health."""

from __future__ import annotations

import os
import threading
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from awo_executor.callback import HttpCallbackClient
from awo_executor.engine import run_job

app = FastAPI(title="awo-executor", version="0.1.0")


def _expected_token() -> str:
    token = os.environ.get("EXECUTOR_TOKEN")
    if not token:
        raise HTTPException(
            status_code=500,
            detail="EXECUTOR_TOKEN is not set on the executor",
        )
    return token


def _check_token(
    x_executor_token: str | None,
    authorization: str | None,
) -> str:
    expected = _expected_token()
    provided = x_executor_token
    if not provided and authorization:
        # Accept "Bearer <token>" or raw token in Authorization
        auth = authorization.strip()
        if auth.lower().startswith("bearer "):
            provided = auth[7:].strip()
        else:
            provided = auth
    if not provided or provided != expected:
        raise HTTPException(status_code=401, detail="invalid executor token")
    return expected


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/v1/jobs")
async def create_job(
    request: Request,
    x_executor_token: str | None = Header(default=None, alias="X-Executor-Token"),
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    server_token = _check_token(x_executor_token, authorization)
    try:
        body: dict[str, Any] = await request.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"invalid JSON: {e}") from e

    required = (
        "run_id",
        "flow_version_id",
        "graph",
        "input",
        "callback_base_url",
        "token",
    )
    missing = [k for k in required if k not in body]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"missing fields: {', '.join(missing)}",
        )

    # Job token should match shared secret (control plane sends EXECUTOR_TOKEN)
    job_token = body.get("token")
    if not isinstance(job_token, str) or job_token != server_token:
        raise HTTPException(status_code=401, detail="job token mismatch")

    thread = threading.Thread(
        target=_execute_safe,
        args=(body,),
        daemon=True,
        name=f"run-{body['run_id']}",
    )
    thread.start()
    return JSONResponse({"accepted": True, "run_id": body["run_id"]}, status_code=202)


def _execute_safe(job: dict[str, Any]) -> None:
    try:
        client = HttpCallbackClient(job["callback_base_url"], job["token"])
        run_job(job, client)
    except Exception as exc:  # noqa: BLE001 — last-resort fail status
        try:
            client = HttpCallbackClient(job["callback_base_url"], job["token"])
            client.post_status(
                job["run_id"],
                "failed",
                error_message=f"executor internal error: {exc}",
            )
        except Exception:
            pass

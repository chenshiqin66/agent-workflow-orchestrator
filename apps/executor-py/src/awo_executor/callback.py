"""HTTP callbacks to the control plane."""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any

import httpx


class CallbackClient(ABC):
    @abstractmethod
    def post_status(
        self,
        run_id: str,
        status: str,
        *,
        output: Any = None,
        error_message: str | None = None,
    ) -> None: ...

    @abstractmethod
    def post_event(
        self,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
        *,
        node_id: str | None = None,
    ) -> None: ...


class HttpCallbackClient(CallbackClient):
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "X-Executor-Token": self.token,
        }

    def post_status(
        self,
        run_id: str,
        status: str,
        *,
        output: Any = None,
        error_message: str | None = None,
    ) -> None:
        body: dict[str, Any] = {"status": status}
        if output is not None:
            body["output"] = output
        if error_message is not None:
            body["error_message"] = error_message
        url = f"{self.base_url}/internal/runs/{run_id}/status"
        with httpx.Client(timeout=self.timeout) as client:
            res = client.post(url, json=body, headers=self._headers())
            res.raise_for_status()

    def post_event(
        self,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
        *,
        node_id: str | None = None,
    ) -> None:
        body: dict[str, Any] = {
            "event_type": event_type,
            "payload": payload,
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        if node_id is not None:
            body["node_id"] = node_id
        url = f"{self.base_url}/internal/runs/{run_id}/events"
        with httpx.Client(timeout=self.timeout) as client:
            res = client.post(url, json=body, headers=self._headers())
            res.raise_for_status()

from __future__ import annotations

from typing import Any

import pytest

from awo_executor.callback import CallbackClient
from awo_executor.engine import run_job


class RecordingCallback(CallbackClient):
    """In-memory callback sink for unit tests (no HTTP)."""

    def __init__(self) -> None:
        self.statuses: list[dict[str, Any]] = []
        self.events: list[dict[str, Any]] = []

    def post_status(
        self,
        run_id: str,
        status: str,
        *,
        output: Any = None,
        error_message: str | None = None,
    ) -> None:
        body: dict[str, Any] = {"run_id": run_id, "status": status}
        if output is not None:
            body["output"] = output
        if error_message is not None:
            body["error_message"] = error_message
        self.statuses.append(body)

    def post_event(
        self,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
        *,
        node_id: str | None = None,
    ) -> None:
        self.events.append(
            {
                "run_id": run_id,
                "event_type": event_type,
                "node_id": node_id,
                "payload": payload,
            }
        )


def test_happy_path_fixture_graph(job_payload: dict):
    cb = RecordingCallback()
    run_job(job_payload, cb)

    assert [s["status"] for s in cb.statuses] == ["running", "succeeded"]
    assert cb.statuses[-1]["output"]["ok"] is True
    assert cb.statuses[-1]["output"]["question"] == "hello"
    assert cb.statuses[-1]["output"]["label"] == "ready"

    types = [e["event_type"] for e in cb.events]
    assert types[0] == "run_started"
    assert "emit" in types
    assert types.count("node_started") >= 5
    assert types.count("node_finished") >= 5
    assert "node_failed" not in types

    # Per-node finished payloads include duration_ms and IO
    finished = [e for e in cb.events if e["event_type"] == "node_finished"]
    for ev in finished:
        assert "duration_ms" in ev["payload"]
        assert "input" in ev["payload"]
        assert "output" in ev["payload"]

    emit_ev = next(e for e in cb.events if e["event_type"] == "emit")
    assert emit_ev["payload"]["message"] == "branch took success"
    assert emit_ev["node_id"] == "n_emit"

    # Visited success path end, not failure end
    node_ids_finished = [e["node_id"] for e in finished]
    assert "n_end_ok" in node_ids_finished
    assert "n_end_fail" not in node_ids_finished


def test_branch_failure_path(job_payload: dict):
    job = dict(job_payload)
    graph = dict(job["graph"])
    nodes = []
    for n in graph["nodes"]:
        if n["id"] == "n_transform":
            n = dict(n)
            n["config"] = {"assignments": {"ok": False}}
        nodes.append(n)
    graph["nodes"] = nodes
    job["graph"] = graph

    cb = RecordingCallback()
    run_job(job, cb)

    assert cb.statuses[-1]["status"] == "succeeded"
    finished_ids = [
        e["node_id"]
        for e in cb.events
        if e["event_type"] == "node_finished"
    ]
    assert "n_end_fail" in finished_ids
    assert "n_emit" not in finished_ids


def test_unsupported_node_fails_run(job_payload: dict):
    job = dict(job_payload)
    graph = dict(job["graph"])
    nodes = list(graph["nodes"])
    nodes.append(
        {
            "id": "n_http",
            "type": "HTTP",
            "config": {},
            "ui": {"x": 0, "y": 0},
        }
    )
    # Insert HTTP between transform and branch
    edges = []
    for e in graph["edges"]:
        if e["id"] == "e2":
            edges.append(
                {
                    **e,
                    "id": "e2a",
                    "target": "n_http",
                }
            )
            edges.append(
                {
                    "id": "e2b",
                    "source": "n_http",
                    "sourceHandle": "out",
                    "target": "n_branch",
                    "targetHandle": "in",
                    "kind": "default",
                    "label": "",
                }
            )
        else:
            edges.append(e)
    graph["nodes"] = nodes
    graph["edges"] = edges
    job["graph"] = graph

    cb = RecordingCallback()
    run_job(job, cb)

    assert cb.statuses[-1]["status"] == "failed"
    assert any(e["event_type"] == "node_failed" for e in cb.events)
    failed = next(e for e in cb.events if e["event_type"] == "node_failed")
    assert failed["payload"].get("error_code") == "unsupported_node_type"


def test_branch_success_with_only_default_edge_fails(job_payload: dict):
    """Branch true + only default outgoing → node_failed (no success↔default alias)."""
    job = dict(job_payload)
    graph = dict(job["graph"])
    edges = []
    for e in graph["edges"]:
        if e.get("source") == "n_branch":
            # drop success/failure; leave a single default (wrong for Branch)
            continue
        edges.append(e)
    edges.append(
        {
            "id": "e_branch_default_only",
            "source": "n_branch",
            "sourceHandle": "out",
            "target": "n_emit",
            "targetHandle": "in",
            "kind": "default",
            "label": "",
        }
    )
    graph["edges"] = edges
    job["graph"] = graph

    cb = RecordingCallback()
    run_job(job, cb)

    assert cb.statuses[-1]["status"] == "failed"
    failed = [e for e in cb.events if e["event_type"] == "node_failed"]
    assert len(failed) == 1
    assert failed[0]["node_id"] == "n_branch"
    assert failed[0]["payload"].get("error_code") == "missing_edge"
    branch_events = [
        e["event_type"] for e in cb.events if e.get("node_id") == "n_branch"
    ]
    assert "node_started" in branch_events
    assert "node_failed" in branch_events
    assert "node_finished" not in branch_events


def test_branch_comparison_type_error_emits_node_failed(job_payload: dict):
    """Incompatible compare types → ExpressionError → node_failed + run failed."""
    job = dict(job_payload)
    graph = dict(job["graph"])
    nodes = []
    for n in graph["nodes"]:
        if n["id"] == "n_transform":
            n = dict(n)
            n["config"] = {"assignments": {"n": "x"}}
        if n["id"] == "n_branch":
            n = dict(n)
            n["config"] = {"expression": "state.n > 1"}
        nodes.append(n)
    graph["nodes"] = nodes
    job["graph"] = graph

    cb = RecordingCallback()
    run_job(job, cb)

    assert cb.statuses[-1]["status"] == "failed"
    failed = next(e for e in cb.events if e["event_type"] == "node_failed")
    assert failed["node_id"] == "n_branch"
    assert failed["payload"].get("error_code") == "invalid_expression"
    # Started then failed — no finished for that node
    branch_events = [e["event_type"] for e in cb.events if e.get("node_id") == "n_branch"]
    assert "node_started" in branch_events
    assert "node_failed" in branch_events
    assert "node_finished" not in branch_events

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

    @property
    def final_status(self) -> str | None:
        return self.statuses[-1]["status"] if self.statuses else None

    @property
    def output(self) -> dict[str, Any]:
        if not self.statuses:
            return {}
        out = self.statuses[-1].get("output")
        return out if isinstance(out, dict) else {}

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


MINIMAL_TRANSFORM_GRAPH = {
    "id": "fv_min_tf",
    "state_schema": {"type": "object", "properties": {}},
    "nodes": [
        {"id": "n_start", "type": "Start", "config": {}, "ui": {"x": 0, "y": 0}},
        {
            "id": "n_transform",
            "type": "Transform",
            "config": {"assignments": {"y": 2}},
            "ui": {"x": 160, "y": 0},
        },
        {"id": "n_end", "type": "End", "config": {}, "ui": {"x": 320, "y": 0}},
    ],
    "edges": [
        {
            "id": "e1",
            "source": "n_start",
            "sourceHandle": "out",
            "target": "n_transform",
            "targetHandle": "in",
            "kind": "default",
            "label": "",
        },
        {
            "id": "e2",
            "source": "n_transform",
            "sourceHandle": "out",
            "target": "n_end",
            "targetHandle": "in",
            "kind": "default",
            "label": "",
        },
    ],
}


BREAKPOINT_NODE_GRAPH = {
    "id": "fv_bp_node",
    "state_schema": {"type": "object", "properties": {}},
    "nodes": [
        {"id": "n_start", "type": "Start", "config": {}, "ui": {"x": 0, "y": 0}},
        {"id": "n_bp", "type": "Breakpoint", "config": {}, "ui": {"x": 160, "y": 0}},
        {
            "id": "n_transform",
            "type": "Transform",
            "config": {"assignments": {"after_bp": True}},
            "ui": {"x": 320, "y": 0},
        },
        {"id": "n_end", "type": "End", "config": {}, "ui": {"x": 480, "y": 0}},
    ],
    "edges": [
        {
            "id": "e1",
            "source": "n_start",
            "sourceHandle": "out",
            "target": "n_bp",
            "targetHandle": "in",
            "kind": "default",
            "label": "",
        },
        {
            "id": "e2",
            "source": "n_bp",
            "sourceHandle": "out",
            "target": "n_transform",
            "targetHandle": "in",
            "kind": "default",
            "label": "",
        },
        {
            "id": "e3",
            "source": "n_transform",
            "sourceHandle": "out",
            "target": "n_end",
            "targetHandle": "in",
            "kind": "default",
            "label": "",
        },
    ],
}


INPUT_GRAPH = {
    "id": "fv_input",
    "state_schema": {"type": "object", "properties": {}},
    "nodes": [
        {"id": "n_start", "type": "Start", "config": {}, "ui": {"x": 0, "y": 0}},
        {
            "id": "n_input",
            "type": "Input",
            "config": {
                "schema": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                }
            },
            "ui": {"x": 160, "y": 0},
        },
        {"id": "n_end", "type": "End", "config": {}, "ui": {"x": 320, "y": 0}},
    ],
    "edges": [
        {
            "id": "e1",
            "source": "n_start",
            "sourceHandle": "out",
            "target": "n_input",
            "targetHandle": "in",
            "kind": "default",
            "label": "",
        },
        {
            "id": "e2",
            "source": "n_input",
            "sourceHandle": "out",
            "target": "n_end",
            "targetHandle": "in",
            "kind": "default",
            "label": "",
        },
    ],
}


def test_dynamic_breakpoint_pauses_before_enter():
    job = {
        "run_id": "r1",
        "flow_version_id": "fv",
        "graph": MINIMAL_TRANSFORM_GRAPH,
        "input": {"x": 1},
        "breakpoints": ["n_transform"],
        "callback_base_url": "http://example",
        "token": "t",
    }
    cb = RecordingCallback()
    run_job(job, cb)
    types = [e["event_type"] for e in cb.events]
    assert "breakpoint_hit" in types
    assert cb.final_status == "paused" or "breakpoint_hit" in types
    finished_nodes = [
        e["node_id"]
        for e in cb.events
        if e["event_type"] == "node_finished"
    ]
    assert "n_transform" not in finished_nodes
    hit = next(e for e in cb.events if e["event_type"] == "breakpoint_hit")
    assert hit["node_id"] == "n_transform"
    cp = hit["payload"]["checkpoint"]
    assert cp["node_id"] == "n_transform"
    assert cp["pause_kind"] == "breakpoint"
    assert cp["state"] == {"x": 1}  # after Start
    # no node_started for transform
    started = [
        e["node_id"] for e in cb.events if e["event_type"] == "node_started"
    ]
    assert "n_transform" not in started


def test_resume_after_dynamic_breakpoint_enters_node():
    job = {
        "run_id": "r1",
        "flow_version_id": "fv",
        "graph": MINIMAL_TRANSFORM_GRAPH,
        "input": {"x": 1},
        "breakpoints": [],
        "checkpoint": {
            "node_id": "n_transform",
            "state": {"x": 99},
            "pause_kind": "breakpoint",
        },
        "callback_base_url": "http://example",
        "token": "t",
    }
    cb = RecordingCallback()
    run_job(job, cb)
    assert cb.final_status == "succeeded"
    assert cb.output.get("y") == 2
    assert cb.output.get("x") == 99  # checkpoint state, not job.input
    finished = [
        e["node_id"]
        for e in cb.events
        if e["event_type"] == "node_finished"
    ]
    assert "n_transform" in finished
    started = [
        e["node_id"] for e in cb.events if e["event_type"] == "node_started"
    ]
    assert "n_start" not in started  # resume must not re-run Start


def test_resume_dynamic_breakpoint_skips_bp_even_if_still_listed():
    """Resume clears before-enter check once even when node remains in breakpoints."""
    job = {
        "run_id": "r1",
        "flow_version_id": "fv",
        "graph": MINIMAL_TRANSFORM_GRAPH,
        "input": {"x": 1},
        "breakpoints": ["n_transform"],
        "checkpoint": {
            "node_id": "n_transform",
            "state": {"x": 42},
            "pause_kind": "breakpoint",
        },
        "callback_base_url": "http://example",
        "token": "t",
    }
    cb = RecordingCallback()
    run_job(job, cb)
    assert cb.final_status == "succeeded"
    assert "breakpoint_hit" not in [e["event_type"] for e in cb.events]
    assert cb.output.get("x") == 42
    started = [
        e["node_id"] for e in cb.events if e["event_type"] == "node_started"
    ]
    assert "n_start" not in started


def test_breakpoint_node_pauses_then_resume_skips_reentry():
    job = {
        "run_id": "r_bp",
        "flow_version_id": "fv",
        "graph": BREAKPOINT_NODE_GRAPH,
        "input": {},
        "callback_base_url": "http://example",
        "token": "t",
    }
    cb = RecordingCallback()
    run_job(job, cb)
    assert "breakpoint_hit" in [e["event_type"] for e in cb.events]
    assert cb.final_status == "paused"
    hit = next(e for e in cb.events if e["event_type"] == "breakpoint_hit")
    assert hit["node_id"] == "n_bp"
    assert hit["payload"]["checkpoint"]["pause_kind"] == "breakpoint"

    # resume
    job2 = {
        **job,
        "checkpoint": hit["payload"]["checkpoint"],
    }
    cb2 = RecordingCallback()
    run_job(job2, cb2)
    assert cb2.final_status == "succeeded"
    assert cb2.output.get("after_bp") is True
    # Breakpoint node must not finish again on resume
    bp_started = [
        e
        for e in cb2.events
        if e.get("node_id") == "n_bp" and e["event_type"] == "node_started"
    ]
    assert bp_started == []


def test_human_approval_pauses_with_waiting_signal(approval_job: dict):
    cb = RecordingCallback()
    run_job(approval_job, cb)
    types = [e["event_type"] for e in cb.events]
    assert "waiting_signal" in types
    assert cb.final_status == "paused"
    wait = next(e for e in cb.events if e["event_type"] == "waiting_signal")
    assert wait["node_id"] == "n_approve"
    assert wait["payload"]["kind"] == "approval"
    assert wait["payload"]["checkpoint"]["pause_kind"] == "approval"


def test_human_approval_reject_takes_failure_edge(approval_job: dict):
    job = {
        **approval_job,
        "checkpoint": {
            "node_id": "n_approve",
            "state": {"ok": True},
            "pause_kind": "approval",
            "resume_edge_kind": "failure",
        },
    }
    cb = RecordingCallback()
    run_job(job, cb)
    assert cb.final_status == "succeeded"
    assert cb.output.get("path") == "rejected"
    assert not any(
        e.get("node_id") == "n_approve" and e["event_type"] == "node_started"
        for e in cb.events
    )


def test_human_approval_approve_takes_success_edge(approval_job: dict):
    job = {
        **approval_job,
        "checkpoint": {
            "node_id": "n_approve",
            "state": {"ok": True},
            "pause_kind": "approval",
            "resume_edge_kind": "success",
        },
    }
    cb = RecordingCallback()
    run_job(job, cb)
    assert cb.final_status == "succeeded"
    assert cb.output.get("path") == "approved"


def test_input_pauses_then_resume_merges_and_continues():
    job = {
        "run_id": "r_in",
        "flow_version_id": "fv",
        "graph": INPUT_GRAPH,
        "input": {"seed": 1},
        "callback_base_url": "http://example",
        "token": "t",
    }
    cb = RecordingCallback()
    run_job(job, cb)
    wait = next(e for e in cb.events if e["event_type"] == "waiting_signal")
    assert wait["payload"]["kind"] == "input"
    assert wait["payload"].get("schema", {}).get("type") == "object"
    assert cb.final_status == "paused"

    job2 = {
        **job,
        "checkpoint": {
            "node_id": "n_input",
            "state": {"seed": 1, "name": "ada"},
            "pause_kind": "input",
            "pending_input": {"name": "ada"},
        },
    }
    cb2 = RecordingCallback()
    run_job(job2, cb2)
    assert cb2.final_status == "succeeded"
    assert cb2.output.get("name") == "ada"
    assert cb2.output.get("seed") == 1

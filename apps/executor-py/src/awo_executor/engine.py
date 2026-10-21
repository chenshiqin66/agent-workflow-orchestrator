"""Walk a flow graph and emit ordered callbacks."""

from __future__ import annotations

import copy
import time
from typing import Any

from awo_executor.callback import CallbackClient
from awo_executor.nodes import (
    NodeResult,
    execute_branch,
    execute_breakpoint,
    execute_emit,
    execute_end,
    execute_human_approval,
    execute_input,
    execute_llm_stub,
    execute_start,
    execute_transform,
    execute_unsupported,
    pick_default_next,
    pick_resume_edge,
)


def _checkpoint(node_id: str, state: dict[str, Any], pause_kind: str, **extra: Any) -> dict[str, Any]:
    cp: dict[str, Any] = {
        "node_id": node_id,
        "state": copy.deepcopy(state),
        "pause_kind": pause_kind,
    }
    cp.update(extra)
    return cp


def run_job(job: dict[str, Any], callbacks: CallbackClient) -> None:
    run_id = job["run_id"]
    graph = job["graph"]
    job_input = job.get("input") or {}
    if not isinstance(job_input, dict):
        job_input = {}

    nodes_by_id = {n["id"]: n for n in graph.get("nodes") or []}
    edges = list(graph.get("edges") or [])
    breakpoints = set(job.get("breakpoints") or [])
    checkpoint = job.get("checkpoint")
    if checkpoint is not None and not isinstance(checkpoint, dict):
        checkpoint = None

    start = next((n for n in nodes_by_id.values() if n.get("type") == "Start"), None)
    if start is None:
        callbacks.post_status(
            run_id,
            "failed",
            error_message="graph has no Start node",
        )
        return

    callbacks.post_status(run_id, "running")

    resuming = False
    skip_dynamic_bp_once = False
    if checkpoint is not None:
        state: dict[str, Any] = copy.deepcopy(checkpoint.get("state") or {})
        if not isinstance(state, dict):
            state = {}
        current_id: str | None = checkpoint.get("node_id")
        if not isinstance(current_id, str) or not current_id:
            callbacks.post_status(
                run_id,
                "failed",
                error_message="checkpoint missing node_id",
            )
            return
        resuming = True
        callbacks.post_event(
            run_id,
            "log",
            {"message": "resume", "checkpoint_node": current_id},
        )
    else:
        state = {}
        current_id = start["id"]
        callbacks.post_event(
            run_id,
            "run_started",
            {"flow_version_id": job.get("flow_version_id")},
        )

    visited = 0
    max_steps = max(50, len(nodes_by_id) * 10)

    while current_id is not None:
        visited += 1
        if visited > max_steps:
            callbacks.post_status(
                run_id,
                "failed",
                error_message="execution exceeded max steps (possible cycle)",
            )
            return

        node = nodes_by_id.get(current_id)
        if node is None:
            callbacks.post_status(
                run_id,
                "failed",
                error_message=f"unknown node id: {current_id}",
            )
            return

        node_id = node["id"]
        node_type = node.get("type") or ""
        config = node.get("config") or {}
        if not isinstance(config, dict):
            config = {}
        out_edges = [e for e in edges if e.get("source") == node_id]

        # --- resume handling (no re-entry for pause nodes) ---
        if resuming and checkpoint is not None:
            pause_kind = checkpoint.get("pause_kind")
            if pause_kind == "breakpoint" and node_type == "Breakpoint":
                nxt = pick_default_next(out_edges)
                resuming = False
                checkpoint = None
                if nxt is None:
                    callbacks.post_status(
                        run_id,
                        "failed",
                        error_message=f"node {node_id} has no outgoing edge",
                    )
                    return
                current_id = nxt
                continue

            if pause_kind == "approval":
                edge_kind = checkpoint.get("resume_edge_kind") or "success"
                if not isinstance(edge_kind, str):
                    edge_kind = "success"
                nxt = pick_resume_edge(out_edges, edge_kind)
                resuming = False
                checkpoint = None
                if nxt is None:
                    callbacks.post_status(
                        run_id,
                        "failed",
                        error_message=(
                            f"approval resume missing edge kind={edge_kind}"
                        ),
                    )
                    return
                current_id = nxt
                continue

            if pause_kind == "input":
                pending = checkpoint.get("pending_input")
                if isinstance(pending, dict):
                    state = {**state, **pending}
                nxt = pick_default_next(out_edges)
                resuming = False
                checkpoint = None
                if nxt is None:
                    callbacks.post_status(
                        run_id,
                        "failed",
                        error_message=f"node {node_id} has no outgoing edge",
                    )
                    return
                current_id = nxt
                continue

            if pause_kind == "breakpoint":
                # Dynamic breakpoint: enter this node once, skip before-enter BP.
                skip_dynamic_bp_once = True
                resuming = False
                checkpoint = None
                # fall through to enter

        # --- dynamic breakpoint: pause BEFORE enter ---
        if node_id in breakpoints and not skip_dynamic_bp_once:
            cp = _checkpoint(node_id, state, "breakpoint")
            callbacks.post_event(
                run_id,
                "breakpoint_hit",
                {"checkpoint": cp, "state_snapshot": cp["state"]},
                node_id=node_id,
            )
            callbacks.post_status(run_id, "paused")
            return
        skip_dynamic_bp_once = False

        input_snapshot = copy.deepcopy(state)
        callbacks.post_event(
            run_id,
            "node_started",
            {"type": node_type, "input": input_snapshot},
            node_id=node_id,
        )

        t0 = time.perf_counter()
        result = _dispatch(node_type, config, state, job_input, out_edges)
        duration_ms = int((time.perf_counter() - t0) * 1000)

        if not result.ok:
            callbacks.post_event(
                run_id,
                "node_failed",
                {
                    "type": node_type,
                    "input": input_snapshot,
                    "output": result.output,
                    "duration_ms": duration_ms,
                    "error": result.error,
                    "error_code": result.error_code,
                },
                node_id=node_id,
            )
            callbacks.post_status(
                run_id,
                "failed",
                error_message=result.error or "node failed",
            )
            return

        state = result.state

        if result.pause:
            pause_kind = result.pause_kind or "breakpoint"
            cp = _checkpoint(node_id, state, pause_kind)
            if pause_kind == "breakpoint":
                callbacks.post_event(
                    run_id,
                    "breakpoint_hit",
                    {"checkpoint": cp, "state_snapshot": cp["state"]},
                    node_id=node_id,
                )
            else:
                kind = "approval" if pause_kind == "approval" else "input"
                payload: dict[str, Any] = {"kind": kind, "checkpoint": cp}
                if result.waiting_schema is not None:
                    payload["schema"] = result.waiting_schema
                callbacks.post_event(
                    run_id,
                    "waiting_signal",
                    payload,
                    node_id=node_id,
                )
            callbacks.post_status(run_id, "paused")
            return

        if result.emit_payload is not None:
            callbacks.post_event(
                run_id,
                "emit",
                dict(result.emit_payload),
                node_id=node_id,
            )

        callbacks.post_event(
            run_id,
            "node_finished",
            {
                "type": node_type,
                "input": input_snapshot,
                "output": result.output,
                "duration_ms": duration_ms,
            },
            node_id=node_id,
        )

        if result.terminal:
            callbacks.post_status(run_id, "succeeded", output=dict(state))
            return

        if result.next_node_id is not None:
            current_id = result.next_node_id
        else:
            current_id = pick_default_next(out_edges)
            if current_id is None:
                callbacks.post_status(
                    run_id,
                    "failed",
                    error_message=f"node {node_id} has no outgoing edge",
                )
                return

    callbacks.post_status(
        run_id,
        "failed",
        error_message="execution ended without End node",
    )


def _dispatch(
    node_type: str,
    config: dict[str, Any],
    state: dict[str, Any],
    job_input: dict[str, Any],
    out_edges: list[dict[str, Any]],
) -> NodeResult:
    if node_type == "Start":
        return execute_start(job_input, state)
    if node_type == "Transform":
        return execute_transform(config, state)
    if node_type == "Branch":
        return execute_branch(config, state, out_edges)
    if node_type == "Emit":
        return execute_emit(config, state)
    if node_type == "End":
        return execute_end(config, state)
    if node_type == "LLM":
        return execute_llm_stub(config, state)
    if node_type == "Breakpoint":
        return execute_breakpoint(config, state)
    if node_type == "HumanApproval":
        return execute_human_approval(config, state)
    if node_type == "Input":
        return execute_input(config, state)
    return execute_unsupported(node_type, state)

"""Walk a flow graph and emit ordered callbacks."""

from __future__ import annotations

import copy
import time
from typing import Any

from awo_executor.callback import CallbackClient
from awo_executor.nodes import (
    NodeResult,
    execute_branch,
    execute_emit,
    execute_end,
    execute_llm_stub,
    execute_start,
    execute_transform,
    execute_unsupported,
    pick_default_next,
)


def run_job(job: dict[str, Any], callbacks: CallbackClient) -> None:
    run_id = job["run_id"]
    graph = job["graph"]
    job_input = job.get("input") or {}
    if not isinstance(job_input, dict):
        job_input = {}

    nodes_by_id = {n["id"]: n for n in graph.get("nodes") or []}
    edges = list(graph.get("edges") or [])

    start = next((n for n in nodes_by_id.values() if n.get("type") == "Start"), None)
    if start is None:
        callbacks.post_status(
            run_id,
            "failed",
            error_message="graph has no Start node",
        )
        return

    callbacks.post_status(run_id, "running")
    callbacks.post_event(run_id, "run_started", {"flow_version_id": job.get("flow_version_id")})

    state: dict[str, Any] = {}
    current_id: str | None = start["id"]
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

        input_snapshot = copy.deepcopy(state)
        callbacks.post_event(
            run_id,
            "node_started",
            {"type": node_type, "input": input_snapshot},
            node_id=node_id,
        )

        t0 = time.perf_counter()
        out_edges = [e for e in edges if e.get("source") == node_id]
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
    return execute_unsupported(node_type, state)

"""Node executors for the M2 subset."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from awo_executor.expressions import ExpressionError, eval_expression, resolve_state_ref


@dataclass
class NodeResult:
    ok: bool
    state: dict[str, Any]
    output: dict[str, Any] = field(default_factory=dict)
    next_node_id: str | None = None
    terminal: bool = False
    emit_payload: dict[str, Any] | None = None
    error: str | None = None
    error_code: str | None = None


def execute_start(job_input: dict[str, Any], state: dict[str, Any]) -> NodeResult:
    new_state = dict(job_input) if isinstance(job_input, dict) else {}
    return NodeResult(ok=True, state=new_state, output=dict(new_state))


def execute_transform(config: dict[str, Any], state: dict[str, Any]) -> NodeResult:
    assignments = config.get("assignments") or {}
    if not isinstance(assignments, dict):
        return NodeResult(
            ok=False,
            state=state,
            error="Transform.config.assignments must be an object",
            error_code="invalid_config",
        )
    new_state = dict(state)
    try:
        for key, value in assignments.items():
            if not isinstance(key, str) or not key:
                raise ExpressionError("assignment key must be a non-empty string")
            if isinstance(value, dict) and "$ref" in value:
                new_state[key] = resolve_state_ref(str(value["$ref"]), new_state)
            else:
                new_state[key] = value
    except ExpressionError as e:
        return NodeResult(
            ok=False,
            state=state,
            error=str(e),
            error_code="invalid_assignment",
        )
    return NodeResult(ok=True, state=new_state, output=dict(new_state))


def execute_branch(
    config: dict[str, Any],
    state: dict[str, Any],
    edges: list[dict[str, Any]],
) -> NodeResult:
    expr = config.get("expression")
    if not isinstance(expr, str) or not expr.strip():
        # Fallback: config.path + optional compare value
        path = config.get("path")
        if isinstance(path, str) and path.startswith("state."):
            try:
                truthy = bool(resolve_state_ref(path, state))
            except ExpressionError as e:
                return NodeResult(
                    ok=False,
                    state=state,
                    error=str(e),
                    error_code="invalid_expression",
                )
        else:
            return NodeResult(
                ok=False,
                state=state,
                error="Branch requires config.expression or config.path",
                error_code="invalid_config",
            )
    else:
        try:
            truthy = eval_expression(expr, state)
        except ExpressionError as e:
            return NodeResult(
                ok=False,
                state=state,
                error=str(e),
                error_code="invalid_expression",
            )

    kind = "success" if truthy else "failure"
    target = _pick_edge_target(edges, kind)
    if target is None:
        return NodeResult(
            ok=False,
            state=state,
            error=f"Branch missing outgoing edge kind={kind}",
            error_code="missing_edge",
            output={"branch": kind, "result": truthy},
        )
    return NodeResult(
        ok=True,
        state=state,
        output={"branch": kind, "result": truthy},
        next_node_id=target,
    )


def execute_emit(config: dict[str, Any], state: dict[str, Any]) -> NodeResult:
    message = config.get("message", "")
    payload = {"message": message}
    if "payload" in config and isinstance(config["payload"], dict):
        payload = {**payload, **config["payload"]}
    return NodeResult(
        ok=True,
        state=state,
        output=dict(payload),
        emit_payload=dict(payload),
    )


def execute_end(config: dict[str, Any], state: dict[str, Any]) -> NodeResult:
    _ = config
    return NodeResult(
        ok=True,
        state=state,
        output=dict(state),
        terminal=True,
    )


def execute_llm_stub(config: dict[str, Any], state: dict[str, Any]) -> NodeResult:
    text = config.get("stub_text") if isinstance(config.get("stub_text"), str) else "stub"
    new_state = dict(state)
    new_state["llm_text"] = text
    return NodeResult(ok=True, state=new_state, output={"llm_text": text})


def execute_unsupported(node_type: str, state: dict[str, Any]) -> NodeResult:
    return NodeResult(
        ok=False,
        state=state,
        error=f"unsupported node type: {node_type}",
        error_code="unsupported_node_type",
    )


def _pick_edge_target(edges: list[dict[str, Any]], kind: str) -> str | None:
    """Resolve an outgoing edge by exact ``kind`` match only.

    Branch must pass ``success`` or ``failure`` with no aliasing; a missing
    kind fails the node. Linear routing uses :func:`pick_default_next`, which
    may try ``default`` then ``success`` separately.
    """
    for e in edges:
        if e.get("kind") == kind:
            target = e.get("target")
            if isinstance(target, str) and target:
                return target
    return None


def pick_default_next(edges: list[dict[str, Any]]) -> str | None:
    """Next node for linear nodes (Start/Transform/Emit/LLM).

    Prefers ``default``, then ``success`` (exact kinds only — no cross-alias
    inside a single lookup). Falls back to a sole outgoing edge.
    """
    for preferred in ("default", "success"):
        t = _pick_edge_target(edges, preferred)
        if t:
            return t
    # any single outgoing
    if len(edges) == 1:
        t = edges[0].get("target")
        if isinstance(t, str) and t:
            return t
    return None

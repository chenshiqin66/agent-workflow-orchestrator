from __future__ import annotations

import pytest

from awo_executor.expressions import ExpressionError, eval_expression
from awo_executor.nodes import (
    NodeResult,
    execute_branch,
    execute_emit,
    execute_end,
    execute_llm_stub,
    execute_start,
    execute_transform,
    execute_unsupported,
)


def test_start_copies_input_into_state():
    state: dict = {}
    out = execute_start({"question": "hi"}, state)
    assert out.ok
    assert out.state == {"question": "hi"}
    assert out.output == {"question": "hi"}


def test_transform_assignments_and_ref():
    state = {"x": 1}
    result = execute_transform(
        {"assignments": {"ok": True, "y": {"$ref": "state.x"}}},
        state,
    )
    assert result.ok
    assert result.state == {"x": 1, "ok": True, "y": 1}


def test_branch_true_selects_success():
    result = execute_branch(
        {"expression": "state.ok == true"},
        {"ok": True},
        edges=[
            {"kind": "success", "target": "a"},
            {"kind": "failure", "target": "b"},
        ],
    )
    assert result.ok
    assert result.next_node_id == "a"


def test_branch_false_selects_failure():
    result = execute_branch(
        {"expression": "state.ok == true"},
        {"ok": False},
        edges=[
            {"kind": "success", "target": "a"},
            {"kind": "failure", "target": "b"},
        ],
    )
    assert result.ok
    assert result.next_node_id == "b"


def test_branch_missing_edge_fails():
    result = execute_branch(
        {"expression": "state.ok == true"},
        {"ok": True},
        edges=[{"kind": "failure", "target": "b"}],
    )
    assert not result.ok
    assert "missing" in (result.error or "").lower() or "edge" in (
        result.error or ""
    ).lower()


def test_branch_does_not_fallback_to_default_for_success():
    """True Branch must require kind=success; default alone is not enough."""
    result = execute_branch(
        {"expression": "state.ok == true"},
        {"ok": True},
        edges=[{"kind": "default", "target": "only"}],
    )
    assert not result.ok
    assert result.error_code == "missing_edge"
    assert "success" in (result.error or "")
    assert result.next_node_id is None


def test_branch_does_not_fallback_to_default_for_failure():
    """False Branch must require kind=failure; default alone is not enough."""
    result = execute_branch(
        {"expression": "state.ok == true"},
        {"ok": False},
        edges=[{"kind": "default", "target": "only"}],
    )
    assert not result.ok
    assert result.error_code == "missing_edge"
    assert "failure" in (result.error or "")
    assert result.next_node_id is None


def test_comparison_type_error_is_expression_error():
    with pytest.raises(ExpressionError) as ei:
        eval_expression("state.n > 1", {"n": "x"})
    assert "type error" in str(ei.value).lower() or "comparison" in str(ei.value).lower()


def test_branch_comparison_type_error_fails_node():
    result = execute_branch(
        {"expression": "state.n > 1"},
        {"n": "x"},
        edges=[
            {"kind": "success", "target": "a"},
            {"kind": "failure", "target": "b"},
        ],
    )
    assert not result.ok
    assert result.error_code == "invalid_expression"
    assert result.next_node_id is None


def test_emit_carries_message():
    result = execute_emit({"message": "hello"}, {"ok": True})
    assert result.ok
    assert result.emit_payload == {"message": "hello"}
    assert result.state == {"ok": True}


def test_end_marks_terminal():
    result = execute_end({}, {"done": True})
    assert result.ok
    assert result.terminal is True
    assert result.output == {"done": True}


def test_llm_stub_no_network():
    result = execute_llm_stub({"stub_text": "fixed"}, {})
    assert result.ok
    assert result.state["llm_text"] == "fixed"


def test_unsupported_node():
    result = execute_unsupported("HTTP", {})
    assert not result.ok
    assert result.error_code == "unsupported_node_type"


@pytest.mark.parametrize(
    "expr,state,expected",
    [
        ("state.ok == true", {"ok": True}, True),
        ("state.ok == true", {"ok": False}, False),
        ("state.n > 1", {"n": 2}, True),
        ("state.a and state.b", {"a": True, "b": True}, True),
        ("not state.ok", {"ok": False}, True),
        ("(state.n >= 1) or (state.ok == false)", {"n": 0, "ok": False}, True),
    ],
)
def test_safe_expressions(expr, state, expected):
    assert eval_expression(expr, state) is expected


@pytest.mark.parametrize(
    "expr",
    [
        "__import__('os').system('x')",
        "state.ok()",
        "open('/etc/passwd')",
        "state.__class__",
        "eval('1')",
        "state[0]",
    ],
)
def test_unsafe_expressions_rejected(expr):
    with pytest.raises(ExpressionError):
        eval_expression(expr, {"ok": True})

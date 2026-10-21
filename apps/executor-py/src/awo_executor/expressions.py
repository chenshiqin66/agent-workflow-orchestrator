"""Restricted branch expression evaluator — no arbitrary eval."""

from __future__ import annotations

import ast
from typing import Any


class ExpressionError(ValueError):
    """Raised when an expression is unsafe or cannot be evaluated."""


_ALLOWED_CMP = (
    ast.Eq,
    ast.NotEq,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
)


def eval_expression(expr: str, state: dict[str, Any]) -> bool:
    """Evaluate a safe boolean expression against run `state`.

    Allowed:
    - `state.<ident>(.<ident>)*` path reads
    - comparisons `== != > < >= <=`
    - boolean / numeric / string literals
    - `and` / `or` / `not` with parentheses
    """
    if not isinstance(expr, str) or not expr.strip():
        raise ExpressionError("expression must be a non-empty string")
    try:
        tree = ast.parse(expr.strip(), mode="eval")
    except SyntaxError as e:
        raise ExpressionError(f"syntax error: {e}") from e
    value = _eval_node(tree.body, state)
    return bool(value)


def _eval_node(node: ast.AST, state: dict[str, Any]) -> Any:
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (bool, int, float, str, type(None))):
            return node.value
        raise ExpressionError(f"disallowed literal: {type(node.value)!r}")

    if isinstance(node, ast.Name):
        # Allow Python and JSON/JS-style boolean / null literals
        if node.id in ("True", "true"):
            return True
        if node.id in ("False", "false"):
            return False
        if node.id in ("None", "null"):
            return None
        raise ExpressionError(f"disallowed name: {node.id}")

    if isinstance(node, ast.Attribute):
        return _eval_state_path(node, state)

    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        return not bool(_eval_node(node.operand, state))

    if isinstance(node, ast.BoolOp):
        if isinstance(node.op, ast.And):
            result = True
            for v in node.values:
                result = bool(_eval_node(v, state))
                if not result:
                    return False
            return True
        if isinstance(node.op, ast.Or):
            for v in node.values:
                if bool(_eval_node(v, state)):
                    return True
            return False
        raise ExpressionError("unsupported boolean operator")

    if isinstance(node, ast.Compare):
        left = _eval_node(node.left, state)
        for op, comparator in zip(node.ops, node.comparators, strict=True):
            right = _eval_node(comparator, state)
            if not isinstance(op, _ALLOWED_CMP):
                raise ExpressionError(f"disallowed comparison: {type(op).__name__}")
            if isinstance(op, ast.Eq) and not (left == right):
                return False
            if isinstance(op, ast.NotEq) and not (left != right):
                return False
            if isinstance(op, ast.Lt) and not (left < right):
                return False
            if isinstance(op, ast.LtE) and not (left <= right):
                return False
            if isinstance(op, ast.Gt) and not (left > right):
                return False
            if isinstance(op, ast.GtE) and not (left >= right):
                return False
            left = right
        return True

    if isinstance(node, ast.Call):
        raise ExpressionError("function calls are not allowed")
    if isinstance(node, (ast.Subscript, ast.List, ast.Dict, ast.Tuple, ast.Set)):
        raise ExpressionError("containers / subscripts are not allowed")
    if isinstance(node, ast.BinOp):
        raise ExpressionError("arithmetic operators are not allowed")

    raise ExpressionError(f"disallowed syntax: {type(node).__name__}")


def _eval_state_path(node: ast.Attribute, state: dict[str, Any]) -> Any:
    parts: list[str] = []
    cur: ast.AST = node
    while isinstance(cur, ast.Attribute):
        if not isinstance(cur.attr, str) or not cur.attr.isidentifier():
            raise ExpressionError("invalid attribute name")
        if cur.attr.startswith("_"):
            raise ExpressionError("private attributes are not allowed")
        parts.append(cur.attr)
        cur = cur.value
    if not isinstance(cur, ast.Name) or cur.id != "state":
        raise ExpressionError("only state.<path> attribute access is allowed")
    parts.reverse()
    value: Any = state
    for key in parts:
        if not isinstance(value, dict) or key not in value:
            return None
        value = value[key]
    return value


def resolve_state_ref(ref: str, state: dict[str, Any]) -> Any:
    """Resolve `state.a.b` style refs used in Transform `$ref`."""
    if not isinstance(ref, str) or not ref.startswith("state."):
        raise ExpressionError(f"invalid $ref: {ref!r}")
    expr = ref  # reuse path walker via Attribute parse
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as e:
        raise ExpressionError(f"invalid $ref: {ref!r}") from e
    if not isinstance(tree.body, ast.Attribute):
        raise ExpressionError(f"invalid $ref: {ref!r}")
    return _eval_state_path(tree.body, state)

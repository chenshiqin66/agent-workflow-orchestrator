from __future__ import annotations

import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def minimal_graph() -> dict:
    return json.loads((FIXTURES / "minimal_graph.json").read_text())


@pytest.fixture
def m3_approval_graph() -> dict:
    return json.loads((FIXTURES / "m3_approval_graph.json").read_text())


@pytest.fixture
def job_payload(minimal_graph: dict) -> dict:
    return {
        "run_id": "run_test_1",
        "flow_version_id": "fv_m2_demo",
        "graph": minimal_graph,
        "input": {"question": "hello"},
        "callback_base_url": "http://callback.test",
        "token": "dev-token",
    }


@pytest.fixture
def approval_job(m3_approval_graph: dict) -> dict:
    return {
        "run_id": "run_m3_approval",
        "flow_version_id": "fv_m3_approval",
        "graph": m3_approval_graph,
        "input": {"ok": True},
        "callback_base_url": "http://callback.test",
        "token": "dev-token",
    }

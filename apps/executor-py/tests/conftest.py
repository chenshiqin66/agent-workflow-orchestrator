from __future__ import annotations

import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def minimal_graph() -> dict:
    return json.loads((FIXTURES / "minimal_graph.json").read_text())


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

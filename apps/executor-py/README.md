# `@awo` Python executor (`apps/executor-py`)

Minimal graph engine for M2 test runs. Receives `JobPayload` over HTTP, walks
`Start` → `Transform` → `Branch` → `Emit` → `End` (plus optional `LLM` stub),
and POSTs status/events back to the control plane.

## Run locally

```bash
cd apps/executor-py
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"

EXECUTOR_TOKEN=dev \
  uvicorn awo_executor.main:app --app-dir src --port 8790
```

Control plane should set:

- `EXECUTOR_URL=http://127.0.0.1:8790`
- `EXECUTOR_TOKEN=dev`
- `CALLBACK_BASE_URL=http://127.0.0.1:8787`

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | `{ "ok": true }` |
| `POST` | `/v1/jobs` | `202` immediately; requires `X-Executor-Token` matching `EXECUTOR_TOKEN` |

## Tests

```bash
.venv/bin/python -m pytest
```

## Safety

Branch expressions use a restricted AST evaluator (`expressions.py`):
`state.<path>` reads, comparisons, `and`/`or`/`not`, literals only — no
`eval()`, calls, or imports.

# Test fixtures

## `llama-server-models.json`

A trimmed but **field-exact** capture of `GET /v1/models` from a live
`llama-server` in router mode (2026-10-18).

The file is strict JSON — no comments — because it is parsed with `JSON.parse`.
Provenance lives in `llama-server-fixture.test.ts` instead.

### Why this fixture exists

The response shape is not guessable, and guessing it already went wrong once:
an early version of the `doctor` script read a top-level `context_length` and
reported "no context" for every model, because the real server never sends one.

Three properties of the real payload are easy to regress:

- **No top-level `context_length` / `context_window`.** For an unloaded model the
  serving context appears only as `--ctx-size` inside `status.args`.
- **`meta` is absent on unloaded models**, and appears only once loaded. It
  carries `n_ctx` (serving) alongside `n_ctx_train` (trained maximum) — these are
  different numbers and only the former should ever be advertised.
- **`status.args` is ~97 tokens** of real llama-server argv including presets.

### Regenerating

```bash
curl -s http://localhost:9931/v1/models \
  | jq '.data | map(select(.id | IN("...", "...")))' \
  > test/fixtures/llama-server-models.json
```

Keep at least one model in each distinct state: `loaded` (so `meta` is
represented), `unloaded` with a multimodal `architecture` block, and one with
audio in `input_modalities`. If an upstream llama.cpp release changes any of
these fields, the fixture is where it should fail first — before the catalog
silently mis-reports context and throughput collapses with no error.
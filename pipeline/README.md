# Genesis Pipeline

Python agentic backend for Genesis AI. Turns a user intake (lot, sqft,
beds/baths, style) into a structured `FloorPlan` JSON that the React
front end renders in 3D.

This is the home of the agents, geometry solver, and (later) Blender /
Unreal renderer. The wire format lives in `schemas.py` and mirrors
`src/lib/floorplan.ts` exactly.

## Layout

```
pipeline/
├── agents/
│   ├── architect.py        # Intake -> Program (rooms + target areas) + brief
│   └── code_check.py       # Deterministic IRC pass over a FloorPlan
├── geometry/
│   ├── floorplan.py        # Program -> FloorPlan (rooms, walls, openings, furniture)
│   ├── plan_to_3d.py       # FastAPI-side runner: spawns Blender headless
│   └── blender_build.py    # Runs INSIDE Blender; extrudes shell + cuts openings + exports GLB
├── llm/
│   ├── client.py           # OpenAI-compatible client (any provider)
│   └── prompts.py          # Architect system + user prompts
├── api/
│   └── server.py           # FastAPI app: /generate_house, /build_shell, /artifacts/*
├── _artifacts/             # gitignored: per-job GLBs / logs / plan dumps
├── schemas.py              # Pydantic models (mirror of src/lib/floorplan.ts)
├── requirements.txt
└── .env.example
```

## Cycles hero renders

`POST /render_views` produces photoreal PNGs of the home using Blender
Cycles with OpenImageDenoise. Default views: `exterior_front`,
`exterior_aerial`, `interior_living`, `interior_master`. Cameras are
placed automatically based on the FloorPlan's room kinds (entry,
living_room, master_bedroom). Optional GPU device via `--use-gpu`.

Request shape:

```json
{
  "plan": { ... },
  "views": ["exterior_front", "exterior_aerial", "interior_living", "interior_master"],
  "samples": 32,
  "resolution": [1280, 720],
  "use_gpu": false,
  "job_id": null
}
```

Pass an existing `job_id` (from `/build_shell`) to land renders next to
the GLB. Response carries one `url` per rendered view, served from
`/artifacts/<job_id>/render_<view>.png`. The brief panel calls this
endpoint when the user clicks **Render** and shows the resulting
thumbnails inline (with a click-to-zoom lightbox + per-view download).

Render time on CPU: ~30–90s per view at 32 samples / 720p. On GPU
(CUDA / OptiX / Metal / HIP / oneAPI), it's a few seconds total.

## Blender shell builder

`POST /build_shell` takes a FloorPlan and returns a `.glb` of a real
3D shell:

- one floor slab per Room
- one extruded wall mesh per Wall
- a Boolean DIFFERENCE cut for every Opening (door / window / garage door)
- a simple gable roof over the footprint envelope

Response shape:

```json
{
  "job_id": "ab12cd34ef56",
  "glb_url": "/artifacts/ab12cd34ef56/shell.glb",
  "duration_s": 4.7,
  "blender_bin": "/Applications/Blender.app/Contents/MacOS/Blender"
}
```

The GLB is served statically from `/artifacts/<job_id>/shell.glb` so
the React viewer can `useGLTF()` it directly. Plan JSON + build log are
saved next to it for debugging. If Blender isn't installed,
`/build_shell` returns 503 with a setup hint and the editor shows the
shell card in a "failed" state with the same hint -- the rest of the
pipeline keeps working with the templated primitive scene.

Install:

```bash
# macOS
brew install --cask blender
# Ubuntu
sudo apt install blender
# Windows: installer at https://www.blender.org/download/
```

Override the binary path with `GENESIS_BLENDER_BIN`. Resolution order:
1. `GENESIS_BLENDER_BIN` env var
2. `blender` on `PATH`
3. macOS app bundle default at `/Applications/Blender.app/Contents/MacOS/Blender`

## Render-critique agent (FastVLM)

After `/render_views` produces hero PNGs, `POST /critique_renders` runs
each rendered view through the configured VLM with an architect-quality
critique prompt and returns structured per-view feedback + an aggregate
score:

```json
{
  "job_id": "ab12cd34ef56",
  "critiques": [
    {
      "view": "exterior_front",
      "url": "/artifacts/ab12cd34ef56/render_exterior_front.png",
      "strengths": ["clean massing", "warm material palette"],
      "issues": ["entry door reads slightly small", "porch lighting flat"],
      "suggestions": ["raise the porch ceiling 6\""],
      "score": 7.5,
      "summary": "Solid exterior; minor scale and lighting tweaks."
    }, ...
  ],
  "average_score": 7.4,
  "overall_summary": "Across 4 views, the home reads as solid with refinements possible (avg 7.4/10). Recurring concerns: entry door reads small.",
  "backend": "fastvlm",
  "model": "FastVLM-0.5B",
  "duration_s": 18.3,
  "warnings": []
}
```

Request shape:

```json
{
  "job_id": "ab12cd34ef56",     // from a prior /render_views response
  "views": ["exterior_front"],   // optional: filter to a subset
  "max_tokens": 500              // optional: per-view VLM budget
}
```

The agent is best-effort: every per-view failure becomes an `error`
field on that critique entry. The pipeline never blocks on critique
failures. Path-traversal in `job_id` is rejected with a 400; unknown
views are rejected with a 400; missing job dirs return 200 with an
explanatory warning.

The brief panel surfaces this with a green **Critique** button that
appears next to the **Render** button after Cycles finishes. Critique
results render below the thumbnails: aggregate score with backend
badge, one-line synthesis, and a collapsible card per view showing
strengths / issues / suggestions in green / red / sky-blue tone tags.

## Style-refs agent (FastVLM)

When the user uploads inspiration photos in the intake (`style.refs[]`),
`pipeline/agents/style_refs.py` fetches each image, runs it through the
configured VLM with a JSON-only style-extraction prompt, parses the
result, and aggregates across images into a single `StyleAnalysis`:

```
{
  "archetype":  "farmhouse",
  "materials":  ["white shiplap", "black metal", "oak"],
  "palette":    ["warm white", "charcoal", "walnut"],
  "features":   ["steep gable roof", "board-and-batten", "deep porch"],
  "mood":       "cozy, modern-rustic",
  "refs":       [ /* per-image cues */ ]
}
```

Backends (set `GENESIS_VLM_BACKEND`):

- **`fastvlm`** — Apple FastVLM via MLX, on-device on Apple Silicon.
  Zero-latency, private, no network. `pip install mlx mlx-vlm`. Models:
  `FastVLM-0.5B` (fast), `FastVLM-1.5B`, `FastVLM-7B` (best).
- **`openai`** — any OpenAI-compatible vision endpoint (GPT-4o, LLaVA,
  Qwen-VL, InternVL, etc.). Set `GENESIS_VLM_BASE_URL` +
  `GENESIS_VLM_API_KEY` + `GENESIS_VLM_MODEL`.
- *unset* — refs[] are saved but not analyzed; the brief panel shows
  "No VLM backend configured" so the user knows what to wire up.

The cues are fed two ways:

1. **Architect prompt** — `render_architect_user()` appends a
   `REFERENCE IMAGES` block instructing the LLM to weight the cues at
   least as heavily as the textual style field. If the user left the
   textual `style` blank, the normalized archetype from refs is
   promoted onto the request so even the deterministic fallback uses it.
2. **Brief panel** — the React editor renders a `Style Cues` section
   with the aggregate (archetype / materials / palette / features /
   mood) plus a thumbnail strip showing per-ref status (✓ analyzed,
   ⚠ failed). Backend + model are surfaced as a small badge.

Tuning knobs (kwargs to `analyze_style_refs`):

- `max_refs` (default 4) — only the first N refs are analyzed to keep
  latency bounded; the rest are kept on the request but uncued.
- `max_tokens` (default 400) — VLM response budget per image.

Failure handling: every per-ref failure is recorded as a `StyleCues`
with non-null `error` and surfaced in the panel. The pipeline never
blocks on VLM failures.

## Asset retrieval (TRELLIS / 3D-FUTURE / CC0 packs)

After the architect produces a `FloorPlan`, `pipeline/agents/asset_retrieval.py`
walks every `FurnitureItem` and tries to replace the parametric primitive
with a real GLB mesh. The match is scored on:

1. **Kind** — exact string match (e.g. `"sofa"`).
2. **Dimension proximity** — Gaussian-ish per-axis penalty; a 30 % mismatch
costs heavily, 2× or 0.5× drops the score near zero.
3. **Style overlap** — intersection of the plan's style tags + VLM style cues
with the asset's tags, up to a +50 % bonus.

Sources (loaded in this priority order):

- **Pre-curated GLB packs** — drop `.glb`/`.gltf` files into
`pipeline/assets/library/` and register them in `manifest.json`.
- **3D-FUTURE / 3D-FRONT** — point `GENESIS_ASSET_LIBRARY` at the dataset root;
load via a CSV-to-manifest adapter (see `pipeline/assets/library/README.md`).
- **TRELLIS HTTP endpoint** — set `GENESIS_TRELLIS_ENDPOINT` to a
TRELLIS-compatible on-demand 3D generation service. The fetcher POSTs
`{"kind", "dimensions", "style_tags"}` and caches the returned GLB by
content-hash so repeated queries are free.

Graceful fallback: if the catalog is empty, no entry matches, or a GLB
fails to import in Blender, the parametric builder takes over for that
item. The result is a mix of real meshes and primitives that still
renders correctly.

## Architect agent

The architect runs in two modes:

1. **LLM-backed (preferred)** — when `GENESIS_LLM_BASE_URL` +
   `GENESIS_LLM_API_KEY` are set, the agent calls an open-weights model
   (default **Qwen 2.5 72B Instruct**) through any OpenAI-compatible
   endpoint and asks it to design the room program. The response is
   validated against a Pydantic schema, sanity-checked (entry, bedrooms,
   bathroom, garage required), and scaled to the requested sqft.
2. **Deterministic fallback** — if the LLM is unavailable or the call
   fails, a rule-based program builder runs. The pipeline always
   produces a valid `FloorPlan`.

Why Qwen 2.5 72B Instruct:

- Apache 2.0 license — no commercial restrictions.
- Strongest open-weights model at the 70B scale for structured-output /
  instruction-following tasks (which is exactly what the architect
  needs).
- Hosted by every major OpenAI-compatible provider (OpenRouter,
  Together, Fireworks) and trivial to self-host on a single A100 with
  4-bit AWQ via vLLM.

Drop-in alternatives (just change `GENESIS_ARCHITECT_MODEL`):

| Model                                   | License        | Notes                                    |
|-----------------------------------------|----------------|------------------------------------------|
| `qwen/qwen-2.5-72b-instruct`            | Apache 2.0     | Default. Best balance for this task.     |
| `meta-llama/llama-3.3-70b-instruct`     | Llama 3.3 EULA | Comparable quality; commercial OK <700M MAU. |
| `deepseek/deepseek-chat` (DeepSeek V3)  | MIT            | Top-tier reasoning. Heavier model.       |
| `qwen/qwen-2.5-32b-instruct`            | Apache 2.0     | Fast / fits 1xA100 4-bit.                |
| `qwen/qwen-2.5-7b-instruct`             | Apache 2.0     | Trivial cost / on-device.                |

Planned additions:

```
pipeline/
├── agents/
│   ├── code_check.py       # RAG over IRC/IBC/IECC + local zoning PDFs
│   ├── stylist.py          # SDXL + ControlNet 2D mood/elevation refs
│   └── critic.py           # VLM scoring of rendered candidates
├── geometry/
│   ├── plan_to_3d.py       # Headless Blender extrusion + opening cuts
│   └── assets.py           # TRELLIS + 3D-FUTURE retrieval for furniture
├── render/
│   ├── cycles.py           # Blender Cycles still renders
│   └── unreal_export.py    # FBX/GLB -> Datasmith for Unreal walkthrough
└── training/
    ├── train_architect_lora.py
    ├── train_style_lora.py
    └── train_trellis_lora.py
```

## Quickstart

```bash
# from the repository root
python -m venv .venv
source .venv/bin/activate
pip install -r pipeline/requirements.txt

# optional: copy env template
cp pipeline/.env.example pipeline/.env

# run the API
uvicorn pipeline.api.server:app --reload --port 8787
```

Then in the React app set:

```
VITE_GENESIS_API_URL=http://127.0.0.1:8787
```

and submit the IntakeForm. The "Generate Home" button POSTs to
`/generate_house`, stages the FloorPlan into CreateStudio's draft
storage, and navigates to `/start` so the editor opens with the
generated home.

## Endpoints

### `GET /health`

Liveness probe. Returns `{ ok, service, version }`.

### `POST /generate_house`

Body:

```json
{
  "basics": { "floors": 1, "sqft": 1800 },
  "rooms":  { "beds": 3, "baths": 2, "garage": 2 },
  "style":  { "archetype": "modern", "refs": [] },
  "budget": { "amount": null },
  "notes":  "open kitchen, big windows toward the back yard",
  "seed":   null,
  "lot":    null
}
```

Response:

```json
{
  "plan": { "version": 1, "meta": { ... }, "rooms": [...], "walls": [...], "openings": [...], "furniture": [...] },
  "brief": { "program": "...", "rationale": "...", "warnings": [] }
}
```

## Roadmap

This v1 is fully deterministic. Each subsystem is designed to be replaced
in place:

| Stage | v1 (now)                                      | v2 (planned)                                              |
|-------|-----------------------------------------------|-----------------------------------------------------------|
| Brief | Rule-based program builder                    | Llama 3.1 / Qwen 2.5 LoRA on intake -> brief pairs        |
| Code  | (none)                                        | RAG over IRC/IBC/IECC + zoning text                       |
| Style | (none)                                        | SDXL + ControlNet + IP-Adapter, per-style LoRAs           |
| Plan  | Row-pack solver                               | HouseDiffusion fine-tuned on RPLAN + CubiCasa5K           |
| Shell | StudioObject primitives in the React engine   | Headless Blender extrusion with boolean opening cuts      |
| Assets| Box placeholders                              | TRELLIS LoRA on 3D-FUTURE + retrieval                     |
| Render| (n/a, web preview only)                       | Blender Cycles stills + Unreal Engine 5 Pixel Streaming   |
| Critic| (none)                                        | Qwen2-VL scoring rendered views vs brief                  |
```

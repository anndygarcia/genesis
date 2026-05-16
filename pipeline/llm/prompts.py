"""Prompt templates for the Genesis pipeline agents.

Kept separate from the agent code so we can iterate on prompts and
A/B-test them without touching control flow. The system prompts are
written in second person to anchor the model on a single role and
constrain output to JSON only.
"""

from __future__ import annotations

import json
from typing import Iterable, Optional

from ..schemas import (
    ArchitectBrief,
    GenerateHouseRequest,
    RendersCritique,
    StyleAnalysis,
)


# Allowed RoomKind values, mirrored from schemas.py. Listed explicitly
# in the prompt so the model doesn't invent kinds the solver can't place.
ROOM_KINDS = [
    "entry",
    "living_room",
    "kitchen",
    "dining_room",
    "master_bedroom",
    "bedroom",
    "bathroom",
    "office",
    "garage",
    "hallway",
    "laundry",
    "closet",
]


ARCHITECT_SYSTEM = """You are the architect agent for Genesis AI, a custom-home generator.

You receive a user's intake (sqft, beds, baths, garage bays, style, vibe,
free-form notes, optional reference images) and produce a structured
**design program** -- the list of rooms the home should contain, their
relative sizes, key adjacencies, and a short rationale. Downstream a
deterministic geometry solver will pack these rooms into a code-correct
floorplan, so your job is *program design*, not geometry.

Hard constraints:

- Output ONE JSON object only. No prose, no markdown fences, no commentary.
- Every room's `kind` MUST come from this exact list: {room_kinds}.
- Always include exactly one `entry`. Always include at least one
  `bathroom` if `beds > 0`. Always include the requested number of
  bedrooms (the largest is `master_bedroom`, the rest are `bedroom`).
  If garage bays > 0, include exactly one `garage`.
- `relative_size` is a unitless multiplier vs. the kind's baseline
  area. Use 1.0 for typical, 1.2-1.5 for "generous / entertainer / luxury",
  0.7-0.9 for "compact / minimalist". Do not exceed 2.0 or go below 0.5.
- Adjacencies are pairs of room names that must touch. Use the exact
  `name` strings you assigned. Limit to 4-8 high-value adjacencies.
- Honor the user's free-form notes when they specify rooms, vibes, or
  layout intent. If the notes contradict the basic counts (e.g., user
  says "no garage" but garage > 0 was set), surface a warning rather
  than silently overriding.

Style guidance:

- "modern" / "contemporary"  -> open public spaces, fewer interior walls,
  great room concept where possible.
- "farmhouse" / "ranch-house" -> generous mudroom-adjacent entry, open
  kitchen-dining, prominent master suite.
- "mediterranean" / "spanish" -> larger entry / foyer, courtyard hint via
  generous hallways, formal dining.
- "victorian" -> more discrete rooms, formal dining, sitting room.
- "barndominium" / "log-cabin" -> oversized great room, simple compact
  bedroom wing.

Output schema (JSON):

{{
  "rooms": [
    {{
      "kind": "<one of room_kinds>",
      "name": "<short human label, unique within the home>",
      "relative_size": <number 0.5-2.0>,
      "rationale": "<<= 80 chars on why this room is here>"
    }},
    ...
  ],
  "rationale": "<<= 400 chars summarizing the program>",
  "adjacencies": [
    ["<room name A>", "<room name B>"],
    ...
  ],
  "warnings": ["<short string>", ...]
}}
"""


def render_architect_system() -> str:
    return ARCHITECT_SYSTEM.format(room_kinds=", ".join(ROOM_KINDS))


def render_architect_user(
    req: GenerateHouseRequest,
    *,
    style_cues: Optional[StyleAnalysis] = None,
) -> str:
    """Render the user message: a compact JSON dump of the intake plus an explicit ask.

    If ``style_cues`` is provided (non-empty result from the VLM-backed
    style-refs agent), the cues are appended verbatim so the architect
    can reflect the look-and-feel of the user's uploaded photos.
    """

    intake = {
        "sqft": req.basics.sqft,
        "floors": req.basics.floors,
        "beds": req.rooms.beds,
        "baths": req.rooms.baths,
        "garage_bays": req.rooms.garage,
        "style": req.style.archetype or "modern",
        "reference_image_count": len(req.style.refs or []),
        "budget_usd": req.budget.amount,
        "notes": (req.notes or "").strip(),
        "lot": req.lot.model_dump() if req.lot else None,
    }

    blocks = [
        "Design the program for this home. Use the schema in the system "
        "prompt. Return ONLY the JSON object.",
        "",
        "INTAKE:",
        json.dumps(intake, indent=2),
    ]

    cues_block = _render_style_cues_block(style_cues)
    if cues_block:
        blocks.extend([
            "",
            "REFERENCE IMAGES (analyzed by a vision-language model -- treat as the user's "
            "look-and-feel direction; weight them at least as heavily as the textual style "
            "field above when they conflict):",
            cues_block,
        ])

    return "\n".join(blocks)


def _render_style_cues_block(style_cues: Optional[StyleAnalysis]) -> Optional[str]:
    """Compact, prompt-friendly rendering of the aggregated style cues.

    Skips rendering entirely when the aggregate is empty -- typical
    case is that the VLM ran but every ref errored out, in which case
    we don't want to bloat the architect prompt with an empty block.
    """
    if style_cues is None:
        return None
    has_aggregate = bool(
        style_cues.archetype
        or style_cues.materials
        or style_cues.palette
        or style_cues.features
        or style_cues.mood
    )
    if not has_aggregate:
        return None
    successful_refs = [r for r in style_cues.refs if r.error is None]

    lines: list[str] = [f"  refs_analyzed: {len(successful_refs)}"]
    if style_cues.archetype:
        lines.append(f"  archetype:     {style_cues.archetype}")
    if style_cues.materials:
        lines.append(f"  materials:     {', '.join(style_cues.materials)}")
    if style_cues.palette:
        lines.append(f"  palette:       {', '.join(style_cues.palette)}")
    if style_cues.features:
        lines.append(f"  features:      {', '.join(style_cues.features)}")
    if style_cues.mood:
        lines.append(f"  mood:          {style_cues.mood}")
    return "\n".join(lines)


def join_kinds(kinds: Iterable[str]) -> str:
    return ", ".join(kinds)


# ---------------------------------------------------------------------------
# Refinement prompts (autonomous iteration loop)
# ---------------------------------------------------------------------------
#
# Used by ``architect.build_program_refine``. The architect re-runs with
# the previous program AND a structured summary of the VLM critique of
# the previous render so it can directly address the cited issues. The
# system prompt frames the role explicitly as "iterating on an existing
# design" rather than "designing from scratch", which materially changes
# how a strong instruction-following model approaches the task.

ARCHITECT_REFINE_SYSTEM = """You are the architect agent for Genesis AI, iterating on an existing design.

A previous version of this home was generated, rendered photoreally with
Cycles, and reviewed by a senior-architect VLM. Your job is to produce
a REVISED program that directly addresses the cited issues while
preserving everything that works. This is iteration #{iteration}.

Hard constraints:

- Output ONE JSON object only. No prose, no markdown fences, no commentary.
- The schema is the SAME one you used in the initial pass:
  rooms[], rationale, adjacencies[], warnings[].
- Every room's `kind` MUST come from this exact list: {room_kinds}.
- Always include exactly one `entry`. Always include at least one
  `bathroom` if `beds > 0`. Always include the requested number of
  bedrooms (the largest is `master_bedroom`, the rest are `bedroom`).
  If garage bays > 0, include exactly one `garage`.
- `relative_size` is a unitless multiplier vs. the kind's baseline
  area. Use 1.0 for typical, 1.2-1.5 for "generous / entertainer / luxury",
  0.7-0.9 for "compact / minimalist". Do not exceed 2.0 or go below 0.5.

How to use the critique:

- Read the recurring issues. They tend to be about scale, proportions,
  material cohesion, lighting, or room layout. The geometry solver only
  consumes ROOMS + ADJACENCIES, so map issues to the right axis:
    * "entry door reads small / scale off"   -> increase entry relative_size
    * "ceilings feel low"                    -> note in rationale (downstream
                                                handles ceiling heights)
    * "living feels cramped"                 -> increase living_room relative_size
    * "kitchen-dining poorly connected"      -> add an explicit adjacency
    * "master bedroom feels small"           -> increase master_bedroom
                                                relative_size (1.2-1.5)
    * "no flow between public and private"   -> use a hallway and adjacencies
- If the critique shows the design is mostly working (avg_score >= 8.0),
  make MINIMAL changes -- only what the issues call out. Do not redesign.
- If avg_score is low (< 6.0), it's OK to substantially restructure: the
  user wants a meaningfully different home.
- ALWAYS write a rationale that explicitly references the changes you made
  in response to the critique. Start with phrases like "Widened the entry
  to address the small-door scale concern" -- this is how the user knows
  what was iterated.

Output schema (same as initial pass):

{{
  "rooms": [
    {{
      "kind": "<one of room_kinds>",
      "name": "<short human label, unique within the home>",
      "relative_size": <number 0.5-2.0>,
      "rationale": "<<= 80 chars on why this room is here / what changed>"
    }},
    ...
  ],
  "rationale": "<<= 400 chars summarizing the program AND what changed>",
  "adjacencies": [
    ["<room name A>", "<room name B>"],
    ...
  ],
  "warnings": ["<short string>", ...]
}}
"""


def render_architect_refine_system(*, iteration: int) -> str:
    return ARCHITECT_REFINE_SYSTEM.format(
        room_kinds=", ".join(ROOM_KINDS),
        iteration=max(1, int(iteration)),
    )


def render_architect_refine_user(
    req: GenerateHouseRequest,
    *,
    previous_brief: ArchitectBrief,
    critique: RendersCritique,
    style_cues: Optional[StyleAnalysis] = None,
    iteration: int = 2,
) -> str:
    """Render the refinement user message.

    Bundles the original intake, the previous program / rationale, the
    aggregated VLM critique findings (recurring issues + per-view scores),
    and any style cues into a single prompt the architect can act on.
    """

    intake = {
        "sqft": req.basics.sqft,
        "floors": req.basics.floors,
        "beds": req.rooms.beds,
        "baths": req.rooms.baths,
        "garage_bays": req.rooms.garage,
        "style": req.style.archetype or "modern",
        "reference_image_count": len(req.style.refs or []),
        "budget_usd": req.budget.amount,
        "notes": (req.notes or "").strip(),
        "lot": req.lot.model_dump() if req.lot else None,
    }

    # Pull the most-cited issues across all views (frequency-ranked).
    issue_counts: dict[str, int] = {}
    per_view: list[dict] = []
    for c in critique.critiques or []:
        if c.error:
            continue
        per_view.append({
            "view": c.view,
            "score": c.score,
            "summary": c.summary,
            "issues": c.issues[:3],
            "suggestions": c.suggestions[:2],
        })
        for i in c.issues:
            key = i.strip().lower()
            if key:
                issue_counts[key] = issue_counts.get(key, 0) + 1

    top_issues: list[str] = []
    if issue_counts:
        ranked = sorted(issue_counts.items(), key=lambda kv: -kv[1])
        # Recover the original-cased text for each top key.
        for key, _count in ranked[:5]:
            for c in critique.critiques or []:
                if c.error:
                    continue
                for i in c.issues:
                    if i.strip().lower() == key:
                        top_issues.append(i)
                        break
                if top_issues and top_issues[-1].strip().lower() == key:
                    break

    refinement = {
        "iteration": int(iteration),
        "previous_average_score": critique.average_score,
        "previous_overall_summary": critique.overall_summary,
        "recurring_issues": top_issues,
        "per_view": per_view,
    }

    blocks: list[str] = [
        f"Refine the program for this home -- iteration #{int(iteration)}.",
        "Use the schema in the system prompt. Return ONLY the JSON object.",
        "",
        "ORIGINAL INTAKE:",
        json.dumps(intake, indent=2),
        "",
        "PREVIOUS PROGRAM:",
        previous_brief.program.strip() or "(no program text)",
        "",
        "PREVIOUS RATIONALE:",
        (previous_brief.rationale or "(no rationale)").strip(),
        "",
        "VLM CRITIQUE (architect-quality review of the previous render):",
        json.dumps(refinement, indent=2),
    ]

    cues_block = _render_style_cues_block(style_cues)
    if cues_block:
        blocks.extend([
            "",
            "REFERENCE IMAGES (analyzed by a vision-language model):",
            cues_block,
        ])

    blocks.extend([
        "",
        "Produce the REVISED program now. Make targeted changes that "
        "address the recurring_issues. Do not redesign unless the score "
        "is below 6.0.",
    ])

    return "\n".join(blocks)

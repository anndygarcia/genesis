"""Architect agent.

The architect takes a user intake (sqft, beds, baths, garage, style) and
produces a structured design brief: a program (which rooms to include and
their target areas) plus a short natural-language rationale.

There are two backends:

* ``build_program_llm()`` -- calls an open-weights LLM (default Qwen 2.5
  72B Instruct via any OpenAI-compatible endpoint) to interpret vibe and
  free-form notes, then validates the response with Pydantic.
* ``build_program_rules()`` -- the deterministic rule-based fallback.

``build_program()`` is the public entry point: it tries the LLM first
when configured, and falls back to rules on any failure so the pipeline
always produces *something* the geometry solver can consume. Both
backends emit the same ``Program`` dataclass, so the rest of the
pipeline is unaware which one was used.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import List, Optional, Tuple

from pydantic import BaseModel, Field, field_validator

from ..schemas import (
    ArchitectBrief,
    GenerateHouseRequest,
    RendersCritique,
    RoomKind,
    StyleAnalysis,
)


logger = logging.getLogger("genesis.pipeline.architect")


# Target room areas in m^2. Used as proportional targets when scaling the
# total program to match the user's requested square footage.
ROOM_TARGETS_M2: dict[RoomKind, float] = {
    "living_room":     22.0,
    "kitchen":         14.0,
    "dining_room":     12.0,
    "master_bedroom":  18.0,
    "bedroom":         12.0,
    "bathroom":         5.5,
    "office":          11.0,
    "garage":          36.0,
    "hallway":          8.0,
    "laundry":          4.5,
    "closet":           2.5,
    "entry":            4.0,
}

# Square feet per square meter.
SQFT_PER_M2 = 10.7639


@dataclass(frozen=True)
class ProgramRoom:
    kind: RoomKind
    name: str
    target_m2: float


@dataclass(frozen=True)
class Program:
    rooms: List[ProgramRoom]
    total_target_m2: float
    style: str
    floors: int
    source: str = "rules"
    model: Optional[str] = None
    adjacencies: Tuple[Tuple[str, str], ...] = ()
    rationale: Optional[str] = None
    extra_warnings: Tuple[str, ...] = ()


def build_program(
    req: GenerateHouseRequest,
    *,
    style_cues: Optional[StyleAnalysis] = None,
) -> Program:
    """Public entry: try the LLM agent, fall back to rules on any failure.

    ``style_cues`` is the aggregated VLM analysis of the user's uploaded
    reference images (see ``pipeline.agents.style_refs``). When present,
    it is injected into the LLM architect's user prompt so the program
    actually reflects the vibe of the photos. The deterministic fallback
    consumes a smaller subset (the normalized archetype) so users still
    get *some* benefit from cues even when the LLM is offline.
    """

    # If the user didn't supply an archetype but the VLM extracted one,
    # promote it onto the request so both backends benefit.
    if style_cues and style_cues.archetype and not (req.style.archetype or "").strip():
        try:
            req = req.model_copy(
                update={
                    "style": req.style.model_copy(update={"archetype": style_cues.archetype}),
                }
            )
        except Exception:  # pragma: no cover - never block on this
            pass

    try:
        from ..llm.client import get_default_client
    except Exception as exc:  # pragma: no cover - llm package optional
        logger.info("LLM client import failed (%s); using rule-based architect", exc)
        return build_program_rules(req)

    client = get_default_client()
    if client is None:
        return build_program_rules(req)

    try:
        return build_program_llm(req, client, style_cues=style_cues)
    except Exception as exc:  # noqa: BLE001 - we want a robust fallback
        logger.warning(
            "LLM architect failed (%s: %s); falling back to rule-based program",
            type(exc).__name__,
            exc,
        )
        rules = build_program_rules(req)
        return _with_extra_warnings(
            rules,
            (f"LLM architect unavailable: {type(exc).__name__}; used deterministic fallback.",),
        )


def build_program_rules(req: GenerateHouseRequest) -> Program:
    """Deterministic rule-based program builder. Always succeeds."""

    beds = max(0, int(req.rooms.beds))
    baths = max(0, int(req.rooms.baths))
    garage_bays = max(0, int(req.rooms.garage))
    style = (req.style.archetype or "modern").lower()
    floors = max(1, int(req.basics.floors))

    rooms: List[ProgramRoom] = []

    # Public living core.
    rooms.append(ProgramRoom("entry",       "Entry",       ROOM_TARGETS_M2["entry"]))
    rooms.append(ProgramRoom("living_room", "Living Room", ROOM_TARGETS_M2["living_room"]))
    rooms.append(ProgramRoom("kitchen",     "Kitchen",     ROOM_TARGETS_M2["kitchen"]))
    rooms.append(ProgramRoom("dining_room", "Dining Room", ROOM_TARGETS_M2["dining_room"]))

    # Bedrooms: largest is the master.
    if beds > 0:
        rooms.append(ProgramRoom("master_bedroom", "Master Suite", ROOM_TARGETS_M2["master_bedroom"]))
    for i in range(max(0, beds - 1)):
        rooms.append(ProgramRoom("bedroom", f"Bedroom {i + 2}", ROOM_TARGETS_M2["bedroom"]))

    # Bathrooms: assume one is en-suite to the master, rest are shared.
    for i in range(baths):
        name = "Master Bath" if i == 0 and beds > 0 else f"Bathroom {i + 1}"
        rooms.append(ProgramRoom("bathroom", name, ROOM_TARGETS_M2["bathroom"]))

    # Service rooms.
    rooms.append(ProgramRoom("laundry", "Laundry", ROOM_TARGETS_M2["laundry"]))

    # Garage scales with bay count.
    if garage_bays > 0:
        rooms.append(
            ProgramRoom(
                "garage",
                f"{garage_bays}-Car Garage",
                ROOM_TARGETS_M2["garage"] * garage_bays / 2.0 + ROOM_TARGETS_M2["garage"] * 0.5,
            )
        )

    # Total target area in m^2 from sqft.
    target_m2 = max(60.0, float(req.basics.sqft) / SQFT_PER_M2)

    # Scale per-room areas so they sum to the target. Garage is excluded
    # from the scaling because it isn't habitable square footage in most
    # building codes.
    sum_habitable = sum(r.target_m2 for r in rooms if r.kind != "garage")
    if sum_habitable > 0:
        scale = target_m2 / sum_habitable
        scaled: List[ProgramRoom] = []
        for r in rooms:
            if r.kind == "garage":
                scaled.append(r)
            else:
                scaled.append(ProgramRoom(r.kind, r.name, r.target_m2 * scale))
        rooms = scaled

    return Program(
        rooms=rooms,
        total_target_m2=target_m2,
        style=style,
        floors=floors,
        source="rules",
        rationale=None,
    )


# ---------------------------------------------------------------------------
# LLM-backed architect
# ---------------------------------------------------------------------------


class _LLMRoom(BaseModel):
    kind: RoomKind
    name: str
    relative_size: float = Field(default=1.0, ge=0.4, le=2.5)
    rationale: Optional[str] = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("empty name")
        return v


class _LLMArchitectOutput(BaseModel):
    rooms: List[_LLMRoom]
    rationale: Optional[str] = None
    adjacencies: List[List[str]] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)


def build_program_llm(
    req: GenerateHouseRequest,
    client,  # type: ignore[no-untyped-def]
    *,
    style_cues: Optional[StyleAnalysis] = None,
) -> Program:
    """Run the LLM architect and convert its output into a ``Program``."""

    from ..llm.prompts import render_architect_system, render_architect_user

    output = client.chat_json(
        system=render_architect_system(),
        user=render_architect_user(req, style_cues=style_cues),
        schema=_LLMArchitectOutput,
    )

    style = (req.style.archetype or "modern").lower()
    floors = max(1, int(req.basics.floors))

    # Sanity-check + repair: ensure required rooms exist.
    rooms_out: List[ProgramRoom] = []
    seen_names: set[str] = set()
    used_kind_counts: dict[str, int] = {}
    for r in output.rooms:
        # Ensure unique names because the geometry layer keys things by id
        # but we expose names back to the user; duplicates are confusing.
        base_name = r.name
        candidate = base_name
        n = 2
        while candidate in seen_names:
            candidate = f"{base_name} {n}"
            n += 1
        seen_names.add(candidate)

        baseline = ROOM_TARGETS_M2.get(r.kind, 10.0)
        target = max(2.0, baseline * float(r.relative_size))
        rooms_out.append(ProgramRoom(kind=r.kind, name=candidate, target_m2=target))
        used_kind_counts[r.kind] = used_kind_counts.get(r.kind, 0) + 1

    repair_warnings: List[str] = []

    # Required: exactly one entry.
    if used_kind_counts.get("entry", 0) == 0:
        rooms_out.insert(0, ProgramRoom("entry", "Entry", ROOM_TARGETS_M2["entry"]))
        repair_warnings.append("LLM omitted entry; inserted standard entry.")

    # Required: bedroom counts must match intake.
    requested_beds = max(0, int(req.rooms.beds))
    have_master = used_kind_counts.get("master_bedroom", 0)
    have_secondary = used_kind_counts.get("bedroom", 0)
    if requested_beds > 0 and have_master == 0:
        rooms_out.append(ProgramRoom("master_bedroom", "Master Suite", ROOM_TARGETS_M2["master_bedroom"]))
        repair_warnings.append("LLM omitted master bedroom; added one.")
    target_secondary = max(0, requested_beds - 1)
    while have_secondary < target_secondary:
        idx = have_secondary + 2
        rooms_out.append(ProgramRoom("bedroom", f"Bedroom {idx}", ROOM_TARGETS_M2["bedroom"]))
        have_secondary += 1
        repair_warnings.append(f"LLM under-provisioned bedrooms; added Bedroom {idx}.")

    # Required: at least one bathroom if beds > 0.
    if requested_beds > 0 and used_kind_counts.get("bathroom", 0) == 0:
        rooms_out.append(ProgramRoom("bathroom", "Bathroom", ROOM_TARGETS_M2["bathroom"]))
        repair_warnings.append("LLM omitted bathroom; added one for code compliance.")

    # Required: garage if user asked for one.
    requested_garage = max(0, int(req.rooms.garage))
    if requested_garage > 0 and used_kind_counts.get("garage", 0) == 0:
        rooms_out.append(
            ProgramRoom(
                "garage",
                f"{requested_garage}-Car Garage",
                ROOM_TARGETS_M2["garage"] * requested_garage / 2.0 + ROOM_TARGETS_M2["garage"] * 0.5,
            )
        )
        repair_warnings.append("LLM omitted garage; added per intake.")

    # Scale habitable rooms to match requested sqft.
    target_m2 = max(60.0, float(req.basics.sqft) / SQFT_PER_M2)
    sum_habitable = sum(r.target_m2 for r in rooms_out if r.kind != "garage")
    if sum_habitable > 0:
        scale = target_m2 / sum_habitable
        rooms_out = [
            r if r.kind == "garage" else ProgramRoom(r.kind, r.name, r.target_m2 * scale)
            for r in rooms_out
        ]

    adjacencies = tuple(
        (a, b) for pair in (output.adjacencies or []) if len(pair) == 2 for a, b in [pair]
    )

    warnings = tuple((output.warnings or []) + repair_warnings)

    return Program(
        rooms=rooms_out,
        total_target_m2=target_m2,
        style=style,
        floors=floors,
        source="llm",
        model=client.model,
        adjacencies=adjacencies,
        rationale=output.rationale,
        extra_warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Refinement (autonomous iteration)
# ---------------------------------------------------------------------------


def build_program_refine(
    req: GenerateHouseRequest,
    *,
    previous_brief: ArchitectBrief,
    critique: RendersCritique,
    iteration: int = 2,
    style_cues: Optional[StyleAnalysis] = None,
) -> Program:
    """Re-run the architect with a previous program + a VLM critique.

    The LLM path is preferred because the value of refinement comes from
    the model interpreting the critique findings as design changes. If
    the LLM is unavailable we fall back to a deterministic "nudge" pass:
    inflate the relative size of any room kind cited in the critique's
    recurring issues. That keeps the loop useful even offline.

    Returns a ``Program`` whose ``source`` includes ``"refine_v{N}"`` so
    the editor can show the iteration provenance distinctly from a
    fresh generate.
    """

    iteration = max(2, int(iteration))

    try:
        from ..llm.client import get_default_client
    except Exception as exc:  # pragma: no cover
        logger.info("LLM client import failed (%s); using rule-based refinement", exc)
        return _refine_program_rules(req, previous_brief, critique, iteration=iteration)

    client = get_default_client()
    if client is None:
        return _refine_program_rules(req, previous_brief, critique, iteration=iteration)

    try:
        return _refine_program_llm(
            req,
            client,
            previous_brief=previous_brief,
            critique=critique,
            iteration=iteration,
            style_cues=style_cues,
        )
    except Exception as exc:  # noqa: BLE001 -- robust fallback
        logger.warning(
            "LLM refinement failed (%s: %s); falling back to deterministic nudge",
            type(exc).__name__,
            exc,
        )
        rules = _refine_program_rules(req, previous_brief, critique, iteration=iteration)
        return _with_extra_warnings(
            rules,
            (f"LLM refinement unavailable: {type(exc).__name__}; used deterministic nudge.",),
        )


def _refine_program_llm(
    req: GenerateHouseRequest,
    client,  # type: ignore[no-untyped-def]
    *,
    previous_brief: ArchitectBrief,
    critique: RendersCritique,
    iteration: int,
    style_cues: Optional[StyleAnalysis] = None,
) -> Program:
    from ..llm.prompts import (
        render_architect_refine_system,
        render_architect_refine_user,
    )

    output = client.chat_json(
        system=render_architect_refine_system(iteration=iteration),
        user=render_architect_refine_user(
            req,
            previous_brief=previous_brief,
            critique=critique,
            style_cues=style_cues,
            iteration=iteration,
        ),
        schema=_LLMArchitectOutput,
    )

    style = (req.style.archetype or "modern").lower()
    floors = max(1, int(req.basics.floors))

    # Reuse the same sanity-check + repair logic the initial pass uses,
    # but inlined here so we can tag the source distinctly.
    rooms_out: List[ProgramRoom] = []
    seen_names: set[str] = set()
    used_kind_counts: dict[str, int] = {}
    for r in output.rooms:
        base_name = r.name
        candidate = base_name
        n = 2
        while candidate in seen_names:
            candidate = f"{base_name} {n}"
            n += 1
        seen_names.add(candidate)
        baseline = ROOM_TARGETS_M2.get(r.kind, 10.0)
        target = max(2.0, baseline * float(r.relative_size))
        rooms_out.append(ProgramRoom(kind=r.kind, name=candidate, target_m2=target))
        used_kind_counts[r.kind] = used_kind_counts.get(r.kind, 0) + 1

    repair_warnings: List[str] = []
    if used_kind_counts.get("entry", 0) == 0:
        rooms_out.insert(0, ProgramRoom("entry", "Entry", ROOM_TARGETS_M2["entry"]))
        repair_warnings.append("Refinement omitted entry; inserted standard entry.")

    requested_beds = max(0, int(req.rooms.beds))
    have_master = used_kind_counts.get("master_bedroom", 0)
    have_secondary = used_kind_counts.get("bedroom", 0)
    if requested_beds > 0 and have_master == 0:
        rooms_out.append(ProgramRoom("master_bedroom", "Master Suite", ROOM_TARGETS_M2["master_bedroom"]))
        repair_warnings.append("Refinement omitted master bedroom; added one.")
    target_secondary = max(0, requested_beds - 1)
    while have_secondary < target_secondary:
        idx = have_secondary + 2
        rooms_out.append(ProgramRoom("bedroom", f"Bedroom {idx}", ROOM_TARGETS_M2["bedroom"]))
        have_secondary += 1
        repair_warnings.append(f"Refinement under-provisioned bedrooms; added Bedroom {idx}.")

    if requested_beds > 0 and used_kind_counts.get("bathroom", 0) == 0:
        rooms_out.append(ProgramRoom("bathroom", "Bathroom", ROOM_TARGETS_M2["bathroom"]))
        repair_warnings.append("Refinement omitted bathroom; added one for code compliance.")

    requested_garage = max(0, int(req.rooms.garage))
    if requested_garage > 0 and used_kind_counts.get("garage", 0) == 0:
        rooms_out.append(
            ProgramRoom(
                "garage",
                f"{requested_garage}-Car Garage",
                ROOM_TARGETS_M2["garage"] * requested_garage / 2.0 + ROOM_TARGETS_M2["garage"] * 0.5,
            )
        )
        repair_warnings.append("Refinement omitted garage; added per intake.")

    target_m2 = max(60.0, float(req.basics.sqft) / SQFT_PER_M2)
    sum_habitable = sum(r.target_m2 for r in rooms_out if r.kind != "garage")
    if sum_habitable > 0:
        scale = target_m2 / sum_habitable
        rooms_out = [
            r if r.kind == "garage" else ProgramRoom(r.kind, r.name, r.target_m2 * scale)
            for r in rooms_out
        ]

    adjacencies = tuple(
        (a, b) for pair in (output.adjacencies or []) if len(pair) == 2 for a, b in [pair]
    )
    warnings = tuple((output.warnings or []) + repair_warnings)

    return Program(
        rooms=rooms_out,
        total_target_m2=target_m2,
        style=style,
        floors=floors,
        source=f"llm+refine_v{iteration}",
        model=client.model,
        adjacencies=adjacencies,
        rationale=output.rationale,
        extra_warnings=warnings,
    )


# Mapping from common critique phrasings to the room kind whose
# ``relative_size`` should grow on a deterministic refinement pass.
_NUDGE_KIND_CUES: Tuple[Tuple[str, RoomKind], ...] = (
    ("entry",          "entry"),
    ("door",           "entry"),
    ("foyer",          "entry"),
    ("living",         "living_room"),
    ("great room",     "living_room"),
    ("kitchen",        "kitchen"),
    ("dining",         "dining_room"),
    ("master",         "master_bedroom"),
    ("primary",        "master_bedroom"),
    ("bedroom",        "bedroom"),
    ("bathroom",       "bathroom"),
    ("bath",           "bathroom"),
    ("garage",         "garage"),
    ("hallway",        "hallway"),
    ("flow",           "hallway"),
)


def _refine_program_rules(
    req: GenerateHouseRequest,
    previous_brief: ArchitectBrief,
    critique: RendersCritique,
    *,
    iteration: int,
) -> Program:
    """Deterministic refinement: nudge sizes for kinds the critique cited.

    Used only when the LLM is unavailable. Re-runs ``build_program_rules``
    to get a fresh program at the requested sqft, then walks every issue
    in the critique and inflates the matching room kind by 15% (capped
    at the schema's 2.0x ceiling). Always produces a valid Program.
    """

    rules = build_program_rules(req)

    # Collect all cited issues (de-duplicated, lowercase).
    issues: list[str] = []
    for c in critique.critiques or []:
        if c.error:
            continue
        for i in c.issues:
            t = i.strip().lower()
            if t and t not in issues:
                issues.append(t)
    if not issues:
        return Program(
            rooms=rules.rooms,
            total_target_m2=rules.total_target_m2,
            style=rules.style,
            floors=rules.floors,
            source=f"rules+refine_v{iteration}",
            adjacencies=rules.adjacencies,
            rationale=(
                "Deterministic refinement: critique surfaced no recurring issues; "
                "reissued the same program."
            ),
            extra_warnings=(
                "LLM unavailable; deterministic nudge had no specific issues to act on.",
            ),
        )

    # Find which kinds to grow.
    boost_kinds: dict[str, float] = {}
    addressed: list[str] = []
    for issue in issues:
        for cue, kind in _NUDGE_KIND_CUES:
            if cue in issue:
                boost_kinds[kind] = boost_kinds.get(kind, 1.0) * 1.15
                addressed.append(issue)
                break

    new_rooms: List[ProgramRoom] = []
    for r in rules.rooms:
        boost = boost_kinds.get(r.kind, 1.0)
        # Cap at 2x baseline -- same ceiling the LLM is told to honor.
        baseline = ROOM_TARGETS_M2.get(r.kind, 10.0)
        capped = min(boost * r.target_m2, 2.0 * baseline)
        new_rooms.append(ProgramRoom(r.kind, r.name, capped))

    # Re-scale habitable area back to the requested sqft so the home
    # doesn't grow uncontrollably across iterations.
    target_m2 = rules.total_target_m2
    sum_habitable = sum(r.target_m2 for r in new_rooms if r.kind != "garage")
    if sum_habitable > 0:
        scale = target_m2 / sum_habitable
        new_rooms = [
            r if r.kind == "garage" else ProgramRoom(r.kind, r.name, r.target_m2 * scale)
            for r in new_rooms
        ]

    note = (
        f"Deterministic refinement: enlarged {sorted(boost_kinds)} in response "
        f"to critique issues."
    )
    return Program(
        rooms=new_rooms,
        total_target_m2=target_m2,
        style=rules.style,
        floors=rules.floors,
        source=f"rules+refine_v{iteration}",
        adjacencies=rules.adjacencies,
        rationale=note,
        extra_warnings=(
            "LLM unavailable; used deterministic nudge for refinement.",
        ),
    )


def _with_extra_warnings(program: Program, warnings: Tuple[str, ...]) -> Program:
    return Program(
        rooms=program.rooms,
        total_target_m2=program.total_target_m2,
        style=program.style,
        floors=program.floors,
        source=program.source,
        model=program.model,
        adjacencies=program.adjacencies,
        rationale=program.rationale,
        extra_warnings=tuple(program.extra_warnings) + tuple(warnings),
    )


# ---------------------------------------------------------------------------
# Brief writer (works with either backend)
# ---------------------------------------------------------------------------


def write_brief(req: GenerateHouseRequest, program: Program) -> ArchitectBrief:
    """Produce a short, human-readable rationale plus warnings."""

    beds = req.rooms.beds
    baths = req.rooms.baths
    garage = req.rooms.garage
    style = program.style.replace("-", " ").title()
    sqft = req.basics.sqft

    program_lines = [
        f"- {r.name}: ~{r.target_m2:.1f} m^2 ({r.target_m2 * SQFT_PER_M2:.0f} sqft)"
        for r in program.rooms
    ]
    program_text = "\n".join(program_lines)

    if program.source == "llm" and program.rationale:
        rationale = program.rationale.strip()
    else:
        rationale = (
            f"Single-story {style} home at ~{sqft:.0f} sqft with {beds} bed / {baths} bath"
            + (f" and a {garage}-car garage" if garage else "")
            + ". The plan groups public spaces (entry, living, kitchen, dining) along "
            "the front of the home and pushes private bedrooms to the rear for acoustic "
            "separation. The master suite sits opposite the secondary bedrooms with its "
            "bath en-suite. A hallway spine connects the two wings."
        )

    warnings: List[str] = []
    if baths == 0 and beds > 0:
        warnings.append("No bathroom requested; added one for code compliance.")
    if program.total_target_m2 < 70:
        warnings.append("Requested square footage is very compact; rooms scaled to minima.")
    if program.floors > 1:
        warnings.append("Multi-story layouts are stacked on a single level for v1; staircase will be added in a later pass.")
    warnings.extend(program.extra_warnings)

    if program.source == "llm" and program.model:
        warnings.append(f"Architect model: {program.model}")

    return ArchitectBrief(program=program_text, rationale=rationale, warnings=warnings)

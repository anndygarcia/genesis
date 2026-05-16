"""Pydantic schemas mirroring src/lib/floorplan.ts.

These are the wire-format types for the pipeline's HTTP API. They are kept
deliberately small and explicit so the contract with the React front end is
easy to evolve. Coordinates are in meters, +Y up, XZ is the floor.
"""

from __future__ import annotations

from typing import List, Literal, Optional, Tuple

from pydantic import BaseModel, Field


RoomKind = Literal[
    "living_room",
    "bedroom",
    "master_bedroom",
    "kitchen",
    "dining_room",
    "bathroom",
    "office",
    "garage",
    "hallway",
    "laundry",
    "closet",
    "entry",
]

OpeningKind = Literal["door", "window", "garage_door"]


class Vec2(BaseModel):
    x: float
    z: float


class Room(BaseModel):
    id: str
    kind: RoomKind
    name: str
    min: Vec2
    max: Vec2
    level: int = 0
    ceilingHeight: float = 2.7


class Wall(BaseModel):
    id: str
    a: Vec2
    b: Vec2
    level: int = 0
    height: float = 2.7
    thickness: float = 0.18
    exterior: bool = False


class Opening(BaseModel):
    id: str
    wallId: str
    kind: OpeningKind
    offset: float
    width: float
    height: float
    sill: float = 0.0


class FurnitureItem(BaseModel):
    id: str
    kind: str
    name: str
    roomId: str
    position: Tuple[float, float, float]
    rotation: Tuple[float, float, float] = (0.0, 0.0, 0.0)
    scale: Tuple[float, float, float] = (1.0, 1.0, 1.0)
    color: Optional[str] = None
    # Asset retrieval (TRELLIS / 3D-FUTURE / CC0 packs). When non-null,
    # the Blender shell builder imports the GLB from ``assetPath`` and
    # scales it to ``scale`` instead of building a parametric primitive
    # for this item. ``assetId`` is the manifest's ``id`` field, kept
    # for traceability and editor display.
    assetPath: Optional[str] = None
    assetId: Optional[str] = None


class FloorPlanMeta(BaseModel):
    style: str
    sqft: float
    floors: int
    generatedAt: str
    seed: int
    source: Optional[str] = "templated_v1"


class FloorPlan(BaseModel):
    version: Literal[1] = 1
    meta: FloorPlanMeta
    rooms: List[Room]
    walls: List[Wall]
    openings: List[Opening]
    furniture: List[FurnitureItem]


# -- Request / response models ---------------------------------------------


class IntakeBasics(BaseModel):
    floors: int = 1
    sqft: float = 1800.0


class IntakeRooms(BaseModel):
    beds: int = 3
    baths: int = 2
    garage: int = 0


class IntakeStyle(BaseModel):
    archetype: str = ""
    refs: List[str] = Field(default_factory=list)


class IntakeBudget(BaseModel):
    amount: Optional[float] = None


class IntakeLot(BaseModel):
    width: Optional[float] = None
    depth: Optional[float] = None
    orientation: Optional[float] = None


class GenerateHouseRequest(BaseModel):
    basics: IntakeBasics = Field(default_factory=IntakeBasics)
    rooms: IntakeRooms = Field(default_factory=IntakeRooms)
    style: IntakeStyle = Field(default_factory=IntakeStyle)
    budget: IntakeBudget = Field(default_factory=IntakeBudget)
    notes: str = ""
    seed: Optional[int] = None
    lot: Optional[IntakeLot] = None


CodeSeverity = Literal["info", "warning", "error"]


class CodeIssue(BaseModel):
    """A single building-code finding from the code/zoning agent.

    `code` is a short tag (e.g. ``IRC-R310.1``) that downstream UIs can
    use to group, link to documentation, or filter by severity. The
    optional id fields point back into the FloorPlan so the editor can
    highlight the offending entity.
    """

    severity: CodeSeverity = "warning"
    code: str
    message: str
    roomId: Optional[str] = None
    wallId: Optional[str] = None
    openingId: Optional[str] = None


# ---------------------------------------------------------------------------
# Style-reference VLM analysis
# ---------------------------------------------------------------------------
#
# Output of pipeline/agents/style_refs.py. The VLM is asked to return a
# JSON object per reference image; we parse and aggregate them into
# ``StyleAnalysis`` which is then both fed into the architect prompt
# AND attached to the ArchitectBrief so the editor can render it.

class StyleCues(BaseModel):
    """Per-image cues extracted by the VLM."""

    image_url: Optional[str] = None
    archetype: Optional[str] = None       # normalized to a known archetype if it matches
    archetype_raw: Optional[str] = None   # whatever the VLM said verbatim
    materials: List[str] = Field(default_factory=list)
    palette: List[str] = Field(default_factory=list)
    features: List[str] = Field(default_factory=list)
    mood: Optional[str] = None
    confidence: float = 0.5
    error: Optional[str] = None           # populated if this single ref failed


class StyleAnalysis(BaseModel):
    """Aggregated VLM analysis across all reference images."""

    refs: List[StyleCues] = Field(default_factory=list)
    archetype: Optional[str] = None       # most common normalized archetype
    materials: List[str] = Field(default_factory=list)
    palette: List[str] = Field(default_factory=list)
    features: List[str] = Field(default_factory=list)
    mood: Optional[str] = None
    backend: Optional[str] = None         # "fastvlm" / "openai" / None
    model: Optional[str] = None
    warnings: List[str] = Field(default_factory=list)


class IterationMeta(BaseModel):
    """Lightweight provenance for refined plans.

    Lets the editor (and downstream tools) know whether this plan is a
    fresh design, a refinement of a previous one, and what the critique
    score of the previous iteration was. The chain of ``previous_job_id``
    + ``iteration`` lets clients render a v1 -> v2 -> v3 history without
    needing server-side state.
    """

    iteration: int = 1
    previous_job_id: Optional[str] = None
    previous_average_score: Optional[float] = None
    addressed_issues: List[str] = Field(default_factory=list)


class ArchitectBrief(BaseModel):
    program: str
    rationale: str
    warnings: List[str] = Field(default_factory=list)
    codeIssues: List[CodeIssue] = Field(default_factory=list)
    styleCues: Optional[StyleAnalysis] = None
    iteration: Optional[IterationMeta] = None


class GenerateHouseResponse(BaseModel):
    plan: FloorPlan
    brief: ArchitectBrief


# ---------------------------------------------------------------------------
# Cycles-render critique (VLM)
# ---------------------------------------------------------------------------
#
# Output of pipeline/agents/render_critique.py. The critique agent runs
# the VLM over each rendered hero view with an architect-quality
# prompt and returns structured per-view findings + an aggregate score.

class RenderCritique(BaseModel):
    """Per-view VLM critique of a single Cycles render."""

    view: str
    url: Optional[str] = None
    strengths: List[str] = Field(default_factory=list)
    issues: List[str] = Field(default_factory=list)
    suggestions: List[str] = Field(default_factory=list)
    score: Optional[float] = None    # 1-10
    summary: Optional[str] = None    # <= 80 chars
    error: Optional[str] = None      # populated when this view's call failed


class RendersCritique(BaseModel):
    """Aggregated critique across the rendered views."""

    job_id: str
    critiques: List[RenderCritique] = Field(default_factory=list)
    average_score: Optional[float] = None
    overall_summary: Optional[str] = None
    backend: Optional[str] = None   # "fastvlm" / "openai"
    model: Optional[str] = None
    duration_s: float = 0.0
    warnings: List[str] = Field(default_factory=list)

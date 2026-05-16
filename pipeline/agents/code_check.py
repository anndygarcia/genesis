"""Code/zoning agent.

Runs a deterministic pass against a generated ``FloorPlan`` and emits a
list of ``CodeIssue`` findings. The checks here cover the high-impact
sections of the IRC (International Residential Code) most relevant to
single-family dwellings:

* IRC R304   - Minimum room area (habitable rooms >= 70 sqft / 6.5 m^2)
* IRC R305.1 - Ceiling height (habitable rooms >= 7'-0" / 2.13 m)
* IRC R310.1 - Emergency Escape and Rescue Openings (egress windows in
                every sleeping room)
* IRC R303.3 - Bathroom ventilation (operable window OR mechanical exhaust)
* IRC R311.1 - Means of egress (at least one exterior door)
* IRC R302   - Garage / dwelling separation (no door directly between
                garage and a sleeping room)

This is intentionally a pure function over the FloorPlan so it stays
fast, deterministic, and trivially unit-testable. A future companion
``code_check_llm()`` will run a RAG pass over the actual code text for
nuanced findings (jurisdiction-specific zoning, energy code, ADA / FHA
when applicable). The deterministic checks always run first; the LLM
pass would only *add* issues, never remove them.

NOTE: This is a design-time advisory tool, not a permit substitute. The
``CodeIssue.message`` strings are written for the homeowner / designer
audience, not the building official, and assume IRC 2021 with no local
amendments. Real construction documents must be reviewed by a licensed
professional.
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple

from ..schemas import (
    CodeIssue,
    FloorPlan,
    Opening,
    Room,
    RoomKind,
    Wall,
)


# Rooms that count as "habitable" under IRC R202 (must be heated, lit,
# and ventilated; bathrooms / closets / utility / hallways / garages
# are excluded).
HABITABLE_KINDS: set[RoomKind] = {
    "living_room",
    "kitchen",
    "dining_room",
    "master_bedroom",
    "bedroom",
    "office",
}

SLEEPING_KINDS: set[RoomKind] = {"master_bedroom", "bedroom"}


SQFT_PER_M2 = 10.7639


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _room_dims(room: Room) -> Tuple[float, float]:
    return (room.max.x - room.min.x, room.max.z - room.min.z)


def _room_area(room: Room) -> float:
    w, d = _room_dims(room)
    return max(0.0, w) * max(0.0, d)


def _wall_length(w: Wall) -> float:
    return math.hypot(w.b.x - w.a.x, w.b.z - w.a.z)


def _wall_serves_room(wall: Wall, room: Room) -> bool:
    """True if a room edge coincides with this wall (axis-aligned)."""
    if abs(wall.a.z - wall.b.z) < 1e-3:
        z = wall.a.z
        if abs(z - room.min.z) > 1e-3 and abs(z - room.max.z) > 1e-3:
            return False
        lo = min(wall.a.x, wall.b.x)
        hi = max(wall.a.x, wall.b.x)
        return hi > room.min.x + 1e-3 and lo < room.max.x - 1e-3
    if abs(wall.a.x - wall.b.x) < 1e-3:
        x = wall.a.x
        if abs(x - room.min.x) > 1e-3 and abs(x - room.max.x) > 1e-3:
            return False
        lo = min(wall.a.z, wall.b.z)
        hi = max(wall.a.z, wall.b.z)
        return hi > room.min.z + 1e-3 and lo < room.max.z - 1e-3
    return False


def _index_openings(plan: FloorPlan) -> Dict[str, List[Opening]]:
    """Group openings by wall id."""
    by_wall: Dict[str, List[Opening]] = {}
    for op in plan.openings:
        by_wall.setdefault(op.wallId, []).append(op)
    return by_wall


def _walls_for_room(plan: FloorPlan, room: Room) -> List[Wall]:
    return [w for w in plan.walls if _wall_serves_room(w, room)]


def _exterior_walls_for_room(plan: FloorPlan, room: Room) -> List[Wall]:
    return [w for w in _walls_for_room(plan, room) if w.exterior]


def _openings_for_room(
    plan: FloorPlan,
    room: Room,
    by_wall: Optional[Dict[str, List[Opening]]] = None,
    *,
    only_exterior: bool = False,
) -> List[Tuple[Wall, Opening]]:
    by_wall = by_wall if by_wall is not None else _index_openings(plan)
    walls = _exterior_walls_for_room(plan, room) if only_exterior else _walls_for_room(plan, room)
    out: List[Tuple[Wall, Opening]] = []
    for w in walls:
        for op in by_wall.get(w.id, []):
            out.append((w, op))
    return out


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


# IRC R304.1 -- min room area 70 sqft for habitable rooms (~6.5 m^2)
R304_MIN_AREA_M2 = 70.0 / SQFT_PER_M2

# IRC R304.2 -- min horizontal dimension 7'-0"
R304_MIN_DIM_M = 2.134

# IRC R305.1 -- min ceiling height 7'-0" for habitable spaces
R305_MIN_CEILING_M = 2.134

# IRC R310.1 -- egress window minimums
R310_MIN_NET_OPEN_M2 = 5.7 / SQFT_PER_M2  # 5.7 sqft net clear opening (5.0 grade-floor)
R310_MIN_OPENING_HEIGHT_M = 24 * 0.0254   # 24 inches
R310_MIN_OPENING_WIDTH_M = 20 * 0.0254    # 20 inches
R310_MAX_SILL_M = 44 * 0.0254             # 44 inches


def check_min_area_and_dim(plan: FloorPlan) -> List[CodeIssue]:
    issues: List[CodeIssue] = []
    for room in plan.rooms:
        if room.kind not in HABITABLE_KINDS:
            continue
        area = _room_area(room)
        if area < R304_MIN_AREA_M2 - 1e-3:
            issues.append(CodeIssue(
                severity="error",
                code="IRC-R304.1",
                message=(
                    f"{room.name} is {area * SQFT_PER_M2:.0f} sqft; habitable rooms must be at least 70 sqft."
                ),
                roomId=room.id,
            ))
        w, d = _room_dims(room)
        if min(w, d) < R304_MIN_DIM_M - 1e-3:
            issues.append(CodeIssue(
                severity="warning",
                code="IRC-R304.2",
                message=(
                    f"{room.name} narrow dimension is {min(w, d):.2f} m "
                    f"({min(w, d) * 3.281:.1f} ft); habitable rooms should be at least 7'-0\"."
                ),
                roomId=room.id,
            ))
    return issues


def check_ceiling_height(plan: FloorPlan) -> List[CodeIssue]:
    issues: List[CodeIssue] = []
    for room in plan.rooms:
        if room.kind not in HABITABLE_KINDS:
            continue
        if room.ceilingHeight < R305_MIN_CEILING_M - 1e-3:
            issues.append(CodeIssue(
                severity="error",
                code="IRC-R305.1",
                message=(
                    f"{room.name} ceiling is {room.ceilingHeight:.2f} m; "
                    "habitable rooms must be at least 7'-0\" (2.13 m)."
                ),
                roomId=room.id,
            ))
    return issues


def check_egress_windows(plan: FloorPlan) -> List[CodeIssue]:
    """Every sleeping room needs an emergency escape window on an exterior wall."""

    issues: List[CodeIssue] = []
    by_wall = _index_openings(plan)
    for room in plan.rooms:
        if room.kind not in SLEEPING_KINDS:
            continue
        ext = _exterior_walls_for_room(plan, room)
        if not ext:
            issues.append(CodeIssue(
                severity="error",
                code="IRC-R310.1",
                message=(
                    f"{room.name} has no exterior wall; bedrooms must have an "
                    "emergency escape and rescue opening to the outside."
                ),
                roomId=room.id,
            ))
            continue

        candidates = _openings_for_room(plan, room, by_wall, only_exterior=True)
        # An exterior door also satisfies R310.
        qualifying = []
        for wall, op in candidates:
            if op.kind in ("door", "garage_door"):
                qualifying.append((wall, op))
                continue
            if op.kind != "window":
                continue
            net_area = op.width * op.height
            if (
                net_area >= R310_MIN_NET_OPEN_M2 - 1e-3
                and op.height >= R310_MIN_OPENING_HEIGHT_M - 1e-3
                and op.width >= R310_MIN_OPENING_WIDTH_M - 1e-3
                and op.sill <= R310_MAX_SILL_M + 1e-3
            ):
                qualifying.append((wall, op))

        if not qualifying:
            # Be specific about why none of the existing windows qualify so
            # the editor / homeowner can fix the right thing.
            details: List[str] = []
            for wall, op in candidates:
                if op.kind != "window":
                    continue
                why: List[str] = []
                if op.width * op.height < R310_MIN_NET_OPEN_M2 - 1e-3:
                    why.append(f"net area {op.width * op.height * SQFT_PER_M2:.1f} sqft < 5.7 sqft")
                if op.height < R310_MIN_OPENING_HEIGHT_M - 1e-3:
                    why.append(f"opening height {op.height:.2f} m < 24\"")
                if op.width < R310_MIN_OPENING_WIDTH_M - 1e-3:
                    why.append(f"opening width {op.width:.2f} m < 20\"")
                if op.sill > R310_MAX_SILL_M + 1e-3:
                    why.append(f"sill {op.sill:.2f} m > 44\"")
                if why:
                    details.append("(" + ", ".join(why) + ")")

            issues.append(CodeIssue(
                severity="error",
                code="IRC-R310.1",
                message=(
                    f"{room.name} needs an egress window (>=5.7 sqft net opening, "
                    "min 24\" tall, 20\" wide, sill <=44\")."
                    + (" Existing windows: " + "; ".join(details) if details else "")
                ),
                roomId=room.id,
            ))
    return issues


def check_bathroom_ventilation(plan: FloorPlan) -> List[CodeIssue]:
    """IRC R303.3: bathrooms need an operable window or mechanical exhaust.

    The pipeline doesn't model mechanical exhaust yet, so we report an info
    issue when a bathroom has no exterior window. This is a design hint,
    not a hard error.
    """

    issues: List[CodeIssue] = []
    by_wall = _index_openings(plan)
    for room in plan.rooms:
        if room.kind != "bathroom":
            continue
        ext_openings = [
            (w, op)
            for w, op in _openings_for_room(plan, room, by_wall, only_exterior=True)
            if op.kind == "window"
        ]
        if not ext_openings:
            issues.append(CodeIssue(
                severity="info",
                code="IRC-R303.3",
                message=(
                    f"{room.name} has no exterior window; will require a "
                    "mechanical exhaust fan vented to the outside."
                ),
                roomId=room.id,
            ))
    return issues


def check_means_of_egress(plan: FloorPlan) -> List[CodeIssue]:
    """IRC R311: at least one exterior door."""

    has_exterior_door = any(
        op.kind in ("door", "garage_door") and any(
            w.id == op.wallId and w.exterior for w in plan.walls
        )
        for op in plan.openings
    )
    if has_exterior_door:
        return []
    return [CodeIssue(
        severity="error",
        code="IRC-R311.1",
        message="Plan has no exterior door. Every dwelling needs at least one means of egress.",
    )]


def check_garage_separation(plan: FloorPlan) -> List[CodeIssue]:
    """IRC R302.5.1: openings between garage and dwelling are restricted;
    openings directly into a sleeping room are prohibited."""

    issues: List[CodeIssue] = []
    garage_rooms = [r for r in plan.rooms if r.kind == "garage"]
    if not garage_rooms:
        return []

    sleeping_by_id: Dict[str, Room] = {r.id: r for r in plan.rooms if r.kind in SLEEPING_KINDS}

    # For each interior wall shared between garage and a sleeping room, check
    # that no opening exists on that wall.
    for garage in garage_rooms:
        garage_walls = {w.id for w in _walls_for_room(plan, garage)}
        for sleep in sleeping_by_id.values():
            sleep_walls = {w.id for w in _walls_for_room(plan, sleep)}
            shared = garage_walls & sleep_walls
            if not shared:
                continue
            offending = [op for op in plan.openings if op.wallId in shared]
            if offending:
                for op in offending:
                    issues.append(CodeIssue(
                        severity="error",
                        code="IRC-R302.5.1",
                        message=(
                            f"Opening between {garage.name} and {sleep.name}: "
                            "doors are prohibited from a garage directly into a sleeping room."
                        ),
                        roomId=sleep.id,
                        wallId=op.wallId,
                        openingId=op.id,
                    ))
            else:
                # Wall is shared without an opening; still note that the
                # builder needs the IRC R302.6 fire-rated assembly here.
                issues.append(CodeIssue(
                    severity="info",
                    code="IRC-R302.6",
                    message=(
                        f"Wall between {garage.name} and {sleep.name} requires "
                        "1/2\" gypsum on the dwelling side (5/8\" Type X if living above)."
                    ),
                    roomId=sleep.id,
                    wallId=next(iter(shared)),
                ))
    return issues


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------


CHECKS = (
    check_min_area_and_dim,
    check_ceiling_height,
    check_egress_windows,
    check_bathroom_ventilation,
    check_means_of_egress,
    check_garage_separation,
)


def review_plan(plan: FloorPlan) -> List[CodeIssue]:
    """Run every deterministic check and return the merged issue list.

    Order is stable: errors first within each check, but checks themselves
    run in declaration order so output is deterministic for snapshot tests.
    """

    issues: List[CodeIssue] = []
    for check in CHECKS:
        issues.extend(check(plan))
    # Stable sort by severity (error -> warning -> info) then by code.
    severity_rank = {"error": 0, "warning": 1, "info": 2}
    issues.sort(key=lambda i: (severity_rank.get(i.severity, 9), i.code))
    return issues

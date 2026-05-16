"""Floorplan solver.

Takes the architect's `Program` (rooms with target areas) and produces a
concrete `FloorPlan`: AABB rectangles for each room, walls along every
shared edge, doors at adjacencies, windows on exterior walls, and a small
amount of furniture per room kind so the 3D editor has something to show.

The algorithm is a deterministic row-pack:

  1. Order rooms by zone (public -> service -> private -> garage).
  2. Pack each zone into one or more horizontal rows (rows run east-west).
  3. The footprint envelope is the AABB of all rooms.
  4. Wall segments are derived by walking each room's four edges and
     classifying them as exterior or interior (shared with another room).

It is purposely simple but produces clean, code-shaped homes that already
beat the existing single-room demo. Real spatial reasoning (HouseDiffusion
fine-tuned on RPLAN, or a constraint solver) plugs in by replacing
`pack_rooms()` while keeping the wall/opening derivation intact.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from ..agents.architect import Program, ProgramRoom
from ..schemas import (
    FloorPlan,
    FloorPlanMeta,
    FurnitureItem,
    GenerateHouseRequest,
    Opening,
    Room,
    RoomKind,
    Vec2,
    Wall,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _uid(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


@dataclass
class _PackedRoom:
    program: ProgramRoom
    x0: float
    z0: float
    x1: float
    z1: float

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def depth(self) -> float:
        return self.z1 - self.z0

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cz(self) -> float:
        return (self.z0 + self.z1) / 2


# Zoning order: public -> service -> private -> garage
ZONE_ORDER: Dict[RoomKind, int] = {
    "entry": 0,
    "living_room": 0,
    "dining_room": 0,
    "kitchen": 0,
    "office": 0,
    "laundry": 1,
    "hallway": 1,
    "closet": 1,
    "master_bedroom": 2,
    "bedroom": 2,
    "bathroom": 2,
    "garage": 3,
}


def _aspect_for(kind: RoomKind) -> float:
    """Preferred width:depth ratio for each room kind."""
    if kind in ("living_room", "garage"):
        return 1.25
    if kind in ("kitchen", "dining_room", "master_bedroom"):
        return 1.15
    if kind == "bathroom":
        return 1.6
    if kind in ("hallway",):
        return 5.0
    return 1.0


def _sized(room: ProgramRoom) -> Tuple[float, float]:
    """Width (x), depth (z) for a target area at the kind's aspect."""
    a = _aspect_for(room.kind)
    # area = w * d, w = a * d -> d = sqrt(area/a)
    d = math.sqrt(max(0.5, room.target_m2) / a)
    w = a * d
    # Clamp to sensible minima per kind.
    min_w, min_d = _minima(room.kind)
    w = max(min_w, w)
    d = max(min_d, d)
    return w, d


def _minima(kind: RoomKind) -> Tuple[float, float]:
    if kind == "bathroom":
        return 1.8, 2.2
    if kind == "closet":
        return 1.0, 1.5
    if kind == "laundry":
        return 1.8, 2.0
    if kind == "hallway":
        return 1.0, 2.5
    if kind == "entry":
        return 1.8, 1.8
    if kind == "garage":
        return 5.5, 5.5
    return 2.6, 2.8


# ---------------------------------------------------------------------------
# Architecture-aware packing
# ---------------------------------------------------------------------------
#
# The packer arranges rooms in a dual-wing layout inspired by real residential
# architecture. Instead of naive row-packing, it:
#
#   1. Separates rooms into public, service, and private zones.
#   2. Places the public zone (entry, living, kitchen, dining) along the
#      front (south) of the home with enforced adjacencies.
#   3. Places private rooms (bedrooms, bathrooms) in a rear wing or side
#      wing depending on the style.
#   4. Adds a hallway spine to connect wings when the plan is large enough.
#   5. Enforces key adjacencies: kitchen↔dining, master↔en-suite bath,
#      garage↔laundry, entry→living room.
#   6. Applies style-specific layout strategies.


# Required adjacency pairs — rooms that should share a wall.
REQUIRED_ADJACENCIES: List[Tuple[str, str]] = [
    ("entry", "living_room"),
    ("living_room", "kitchen"),
    ("kitchen", "dining_room"),
    ("master_bedroom", "bathroom"),  # en-suite
    ("garage", "laundry"),
]


def _place_row(
    rooms: List[ProgramRoom],
    x0: float,
    z0: float,
    max_width: float,
    align_depth: Optional[float] = None,
) -> List[_PackedRoom]:
    """Place rooms left-to-right in a single row, aligning depths."""
    placed: List[_PackedRoom] = []
    cx = x0
    # Compute row depth: use the tallest room, or forced alignment.
    row_depth = align_depth or max((_sized(r)[1] for r in rooms), default=3.0)
    for room in rooms:
        w, d = _sized(room)
        # Stretch depth to match row for clean edges.
        d = row_depth
        placed.append(_PackedRoom(room, cx, z0, cx + w, z0 + d))
        cx += w
    return placed


def _find_room(rooms: List[ProgramRoom], kind: str) -> Optional[ProgramRoom]:
    return next((r for r in rooms if r.kind == kind), None)


def _take_rooms(rooms: List[ProgramRoom], kind: str, count: int = 99) -> Tuple[List[ProgramRoom], List[ProgramRoom]]:
    """Split rooms into (matching, remaining)."""
    matched: List[ProgramRoom] = []
    rest: List[ProgramRoom] = []
    for r in rooms:
        if r.kind == kind and len(matched) < count:
            matched.append(r)
        else:
            rest.append(r)
    return matched, rest


def pack_rooms(program: Program) -> List[_PackedRoom]:
    """Architecture-aware room packer with dual-wing zoning.

    Layout strategy:
        FRONT (z=0):  [Entry] [Living Room] [Kitchen] [Dining Room]
        SPINE:        [Hallway] (connecting corridor)
        REAR LEFT:    [Master Suite] [Master Bath]
        REAR RIGHT:   [Bedroom 2] [Bedroom 3] [Bathroom]
        SIDE:         [Garage] [Laundry]
    """
    all_rooms = list(program.rooms)
    style = program.style.lower()

    # --- Classify rooms by zone ---
    public_kinds = {"entry", "living_room", "kitchen", "dining_room", "office"}
    private_kinds = {"master_bedroom", "bedroom", "bathroom"}
    service_kinds = {"laundry", "hallway", "closet"}
    garage_kinds = {"garage"}

    public: List[ProgramRoom] = []
    private: List[ProgramRoom] = []
    service: List[ProgramRoom] = []
    garage: List[ProgramRoom] = []

    for r in all_rooms:
        if r.kind in public_kinds:
            public.append(r)
        elif r.kind in private_kinds:
            private.append(r)
        elif r.kind in garage_kinds:
            garage.append(r)
        else:
            service.append(r)

    # --- Sort public rooms for optimal adjacency flow ---
    # Desired public flow: Entry → Living → Kitchen → Dining [→ Office]
    PUBLIC_ORDER = {"entry": 0, "living_room": 1, "kitchen": 2, "dining_room": 3, "office": 4}
    public.sort(key=lambda r: PUBLIC_ORDER.get(r.kind, 9))

    # --- Sort private rooms: master first, then secondary beds, then baths ---
    PRIVATE_ORDER = {"master_bedroom": 0, "bedroom": 1, "bathroom": 2}
    private.sort(key=lambda r: (PRIVATE_ORDER.get(r.kind, 9), -r.target_m2))

    # --- Compute overall footprint target ---
    total_m2 = sum(r.target_m2 for r in all_rooms)
    # Wider footprint for larger homes.
    target_aspect = 1.5 if total_m2 > 200 else 1.3
    house_depth = math.sqrt(total_m2 / target_aspect)
    house_width = target_aspect * house_depth

    packed: List[_PackedRoom] = []

    # ===================================================================
    # ROW 1: PUBLIC ZONE (front of house)
    # ===================================================================
    if public:
        public_row = _place_row(public, 0, 0, house_width)
        packed.extend(public_row)

    # Track the deepest edge of the public row.
    public_back = max((p.z1 for p in packed), default=0.0) if packed else 0.0
    public_width = max((p.x1 for p in packed), default=house_width) if packed else house_width

    # ===================================================================
    # HALLWAY SPINE (connects public to private wings)
    # ===================================================================
    has_hallway = len(private) >= 3 or total_m2 > 150
    hallway_depth = 1.4 if has_hallway else 0.0

    if has_hallway:
        hallway_room = ProgramRoom("hallway", "Hallway", public_width * hallway_depth)
        packed.append(_PackedRoom(
            hallway_room,
            0, public_back,
            public_width, public_back + hallway_depth,
        ))

    spine_back = public_back + hallway_depth

    # ===================================================================
    # ROW 2: PRIVATE ZONE (rear of house)
    # ===================================================================
    # Group: master suite + en-suite bath | secondary bedrooms + shared bath
    master_beds, private = _take_rooms(private, "master_bedroom", 1)
    secondary_beds, private = _take_rooms(private, "bedroom")
    baths, private = _take_rooms(private, "bathroom")

    # Master wing (left rear): master bedroom + first bathroom (en-suite)
    master_wing: List[ProgramRoom] = []
    if master_beds:
        master_wing.append(master_beds[0])
    if baths:
        master_wing.append(baths.pop(0))  # En-suite goes with master

    # Secondary wing (right rear): secondary bedrooms + remaining baths
    secondary_wing: List[ProgramRoom] = list(secondary_beds) + list(baths) + list(private)

    # Place master wing (left side of rear)
    if master_wing:
        mw_depth = max((_sized(r)[1] for r in master_wing), default=4.0)
        master_packed = _place_row(master_wing, 0, spine_back, house_width / 2, align_depth=mw_depth)
        packed.extend(master_packed)

    # Place secondary wing (right side of rear)
    if secondary_wing:
        master_end_x = max((p.x1 for p in packed if p.z0 >= spine_back), default=0.0)
        sw_depth = max((_sized(r)[1] for r in secondary_wing), default=4.0)
        # Align depth with master wing for clean back wall.
        if master_wing:
            mw_depth_actual = max((p.z1 - p.z0 for p in packed if p.z0 >= spine_back), default=sw_depth)
            sw_depth = max(sw_depth, mw_depth_actual)
        sec_packed = _place_row(secondary_wing, master_end_x, spine_back, house_width, align_depth=sw_depth)
        packed.extend(sec_packed)

    # ===================================================================
    # SERVICE ZONE: Garage + Laundry (side or appended)
    # ===================================================================
    service_rooms = list(garage) + list(service)
    if service_rooms:
        # Style-specific garage placement:
        #   modern/contemporary: garage on the right side, flush with front
        #   farmhouse/ranch:     garage extends from the right side
        #   spanish/mediterranean: garage set back, courtyard style
        rear_back = max((p.z1 for p in packed), default=spine_back)
        main_right = max((p.x1 for p in packed), default=public_width)

        if style in ("modern", "contemporary"):
            # Side-loaded garage, flush with front
            svc_depth = rear_back  # Full depth of house
            svc_packed = _place_row(service_rooms, main_right, 0, house_width * 2, align_depth=svc_depth)
            packed.extend(svc_packed)
        elif style in ("spanish", "mediterranean"):
            # Garage set back from front, creating a courtyard effect
            svc_packed = _place_row(service_rooms, main_right, public_back, house_width * 2)
            packed.extend(svc_packed)
        else:
            # Default: garage appended to the side at the front
            svc_packed = _place_row(service_rooms, main_right, 0, house_width * 2)
            packed.extend(svc_packed)

    # ===================================================================
    # POST-PROCESSING: Recenter footprint around the origin
    # ===================================================================
    if packed:
        min_x = min(p.x0 for p in packed)
        max_x = max(p.x1 for p in packed)
        min_z = min(p.z0 for p in packed)
        max_z = max(p.z1 for p in packed)
        ox = (min_x + max_x) / 2
        oz = (min_z + max_z) / 2
        for p in packed:
            p.x0 -= ox
            p.x1 -= ox
            p.z0 -= oz
            p.z1 -= oz

    return packed


# ---------------------------------------------------------------------------
# Wall + opening derivation
# ---------------------------------------------------------------------------


@dataclass
class _Edge:
    """An axis-aligned room edge. Used as a key to detect shared edges."""

    axis: str  # 'x' (horizontal edge, varying x) or 'z' (vertical edge, varying z)
    fixed: float
    a: float
    b: float
    room_id: str

    @property
    def length(self) -> float:
        return abs(self.b - self.a)


def _room_edges(room_id: str, p: _PackedRoom) -> List[_Edge]:
    return [
        _Edge("x", p.z0, p.x0, p.x1, room_id),  # north (along +X at z=z0)
        _Edge("x", p.z1, p.x0, p.x1, room_id),  # south
        _Edge("z", p.x0, p.z0, p.z1, room_id),  # west
        _Edge("z", p.x1, p.z0, p.z1, room_id),  # east
    ]


def _segment_overlap(a0: float, a1: float, b0: float, b1: float) -> Optional[Tuple[float, float]]:
    lo = max(min(a0, a1), min(b0, b1))
    hi = min(max(a0, a1), max(b0, b1))
    if hi - lo > 1e-3:
        return lo, hi
    return None


def derive_walls_and_openings(
    rooms: List[Room],
    packed_by_id: Dict[str, _PackedRoom],
    ceiling_h: float,
    thickness: float,
) -> Tuple[List[Wall], List[Opening]]:
    """Walk every room edge, splitting on overlaps to produce walls.

    Shared overlapping segments become a single interior wall plus a door
    between the two rooms. Non-shared portions become exterior wall.
    """

    walls: List[Wall] = []
    openings: List[Opening] = []

    # Collect all edges grouped by (axis, fixed coordinate).
    groups: Dict[Tuple[str, float], List[_Edge]] = {}
    for r in rooms:
        p = packed_by_id[r.id]
        for e in _room_edges(r.id, p):
            key = (e.axis, round(e.fixed, 4))
            groups.setdefault(key, []).append(e)

    front_z = min(p.z0 for p in packed_by_id.values())
    back_z = max(p.z1 for p in packed_by_id.values())

    # Index rooms by id for lookups.
    room_kinds = {r.id: r.kind for r in rooms}
    room_names = {r.id: r.name for r in rooms}
    entry_id = next((r.id for r in rooms if r.kind == "entry"), None)

    def add_wall(axis: str, fixed: float, a: float, b: float, exterior: bool) -> Wall:
        if a > b:
            a, b = b, a
        if axis == "x":
            wa, wb = Vec2(x=a, z=fixed), Vec2(x=b, z=fixed)
        else:
            wa, wb = Vec2(x=fixed, z=a), Vec2(x=fixed, z=b)
        wall = Wall(
            id=_uid("w"),
            a=wa,
            b=wb,
            level=0,
            height=ceiling_h,
            thickness=thickness,
            exterior=exterior,
        )
        walls.append(wall)
        return wall

    def add_opening(wall: Wall, kind: str, width: float, height: float, sill: float) -> None:
        length = math.hypot(wall.b.x - wall.a.x, wall.b.z - wall.a.z)
        if length <= width + 0.6:
            # Wall not long enough to host the opening; skip rather than warp.
            return
        offset = (length - width) / 2
        openings.append(
            Opening(
                id=_uid("op"),
                wallId=wall.id,
                kind=kind,  # type: ignore[arg-type]
                offset=offset,
                width=width,
                height=height,
                sill=sill,
            )
        )

    for (axis, fixed), edges in groups.items():
        # Sort by start coordinate.
        edges_sorted = sorted(edges, key=lambda e: min(e.a, e.b))

        # Pairwise compare to find shared overlaps.
        consumed: List[Tuple[float, float, str, str]] = []  # (lo, hi, room_a, room_b)
        for i in range(len(edges_sorted)):
            for j in range(i + 1, len(edges_sorted)):
                ov = _segment_overlap(edges_sorted[i].a, edges_sorted[i].b,
                                      edges_sorted[j].a, edges_sorted[j].b)
                if ov:
                    consumed.append((ov[0], ov[1], edges_sorted[i].room_id, edges_sorted[j].room_id))

        # Build walls per edge: subtract shared portions to get exterior runs,
        # and emit each shared portion as a single interior wall.
        seen_shared: List[Tuple[float, float, str, str]] = []
        for edge in edges_sorted:
            runs: List[Tuple[float, float]] = [(min(edge.a, edge.b), max(edge.a, edge.b))]
            for (lo, hi, ra, rb) in consumed:
                if edge.room_id not in (ra, rb):
                    continue
                new_runs: List[Tuple[float, float]] = []
                for (a, b) in runs:
                    if hi <= a or lo >= b:
                        new_runs.append((a, b))
                        continue
                    if a < lo:
                        new_runs.append((a, lo))
                    if hi < b:
                        new_runs.append((hi, b))
                runs = new_runs

            for (a, b) in runs:
                if b - a < 0.05:
                    continue
                add_wall(axis, fixed, a, b, exterior=True)

        # Now emit shared interior walls (deduped) + place adjoining doors.
        added_keys: set[Tuple[float, float]] = set()
        for (lo, hi, ra, rb) in consumed:
            key = (round(lo, 3), round(hi, 3))
            if key in added_keys:
                continue
            added_keys.add(key)
            wall = add_wall(axis, fixed, lo, hi, exterior=False)
            # Decide what kind of door (or no door) goes on this interior wall.
            ka = room_kinds.get(ra)
            kb = room_kinds.get(rb)
            if ka in ("hallway",) or kb in ("hallway",):
                add_opening(wall, "door", 0.9, 2.05, 0.0)
            elif ka == "garage" or kb == "garage":
                add_opening(wall, "door", 0.9, 2.05, 0.0)
            elif {ka, kb} & {"bathroom", "bedroom", "master_bedroom", "office"}:
                add_opening(wall, "door", 0.85, 2.05, 0.0)
            elif {ka, kb} & {"living_room", "kitchen", "dining_room", "entry"}:
                # Wide cased opening between public spaces.
                add_opening(wall, "door", 1.6, 2.2, 0.0)

    # Add a front door (entry side) — pick the exterior wall closest to the
    # entry room's south edge.
    if entry_id:
        entry = packed_by_id[entry_id]
        target_z = entry.z1 if abs(entry.z1 - back_z) > abs(entry.z0 - front_z) else entry.z0
        candidates = [w for w in walls if w.exterior and abs(w.a.z - w.b.z) < 1e-3 and abs(w.a.z - target_z) < 1e-3]
        candidates = [w for w in candidates if min(w.a.x, w.b.x) >= entry.x0 - 0.1 and max(w.a.x, w.b.x) <= entry.x1 + 0.1]
        if candidates:
            add_opening(candidates[0], "door", 1.0, 2.1, 0.0)

    # Windows on exterior walls of habitable rooms.
    habitable = {"living_room", "kitchen", "dining_room", "bedroom", "master_bedroom", "office"}
    # Map walls to a touching room (first hit) so we know which kind it serves.
    def _wall_touches(wall: Wall, p: _PackedRoom) -> bool:
        if abs(wall.a.z - wall.b.z) < 1e-3:
            # horizontal wall (constant z)
            z = wall.a.z
            if abs(z - p.z0) < 1e-3 or abs(z - p.z1) < 1e-3:
                lo = min(wall.a.x, wall.b.x)
                hi = max(wall.a.x, wall.b.x)
                return hi > p.x0 + 1e-3 and lo < p.x1 - 1e-3
        else:
            x = wall.a.x
            if abs(x - p.x0) < 1e-3 or abs(x - p.x1) < 1e-3:
                lo = min(wall.a.z, wall.b.z)
                hi = max(wall.a.z, wall.b.z)
                return hi > p.z0 + 1e-3 and lo < p.z1 - 1e-3
        return False

    for wall in walls:
        if not wall.exterior:
            continue
        # Skip walls that already have an opening (front door).
        if any(o.wallId == wall.id for o in openings):
            continue
        served = next(
            (room_kinds[r.id] for r in rooms if _wall_touches(wall, packed_by_id[r.id])),
            None,
        )
        if served not in habitable:
            continue
        length = math.hypot(wall.b.x - wall.a.x, wall.b.z - wall.a.z)
        if length < 1.6:
            continue
        win_w = min(1.6, length - 0.8)
        add_opening(wall, "window", win_w, 1.2, 0.9)

    # Garage door on the longest exterior wall touching the garage.
    garage_room = next((r for r in rooms if r.kind == "garage"), None)
    if garage_room:
        gp = packed_by_id[garage_room.id]
        gwalls = [w for w in walls if w.exterior and _wall_touches(w, gp)]
        gwalls.sort(key=lambda w: math.hypot(w.b.x - w.a.x, w.b.z - w.a.z), reverse=True)
        if gwalls:
            target = gwalls[0]
            # Replace any window already added on this wall with a garage door.
            openings[:] = [o for o in openings if o.wallId != target.id]
            add_opening(target, "garage_door", min(2.4, max(1.8, math.hypot(target.b.x - target.a.x, target.b.z - target.a.z) - 0.6)), 2.1, 0.0)

    return walls, openings


# ---------------------------------------------------------------------------
# Furniture
# ---------------------------------------------------------------------------


def _furniture_for(room: Room) -> List[FurnitureItem]:
    items: List[FurnitureItem] = []
    cx = (room.min.x + room.max.x) / 2
    cz = (room.min.z + room.max.z) / 2
    w = room.max.x - room.min.x
    d = room.max.z - room.min.z

    def add(kind: str, name: str, dx: float, dz: float, sx: float, sy: float, sz: float, ry: float = 0.0, color: Optional[str] = None) -> None:
        items.append(
            FurnitureItem(
                id=_uid("f"),
                kind=kind,
                name=name,
                roomId=room.id,
                position=(cx + dx, sy / 2, cz + dz),
                rotation=(0.0, ry, 0.0),
                scale=(sx, sy, sz),
                color=color,
            )
        )

    if room.kind in ("master_bedroom", "bedroom"):
        bed_w = min(2.1 if room.kind == "master_bedroom" else 1.6, w - 0.8)
        bed_d = min(2.0, d - 1.2)
        add("bed", "Bed", 0, -d * 0.18, bed_w, 0.55, bed_d, 0.0, "#b78b62")
        add("nightstand", "Nightstand", -bed_w / 2 - 0.35, -d * 0.18, 0.5, 0.5, 0.5, 0.0, "#9c7a52")
        add("nightstand", "Nightstand", bed_w / 2 + 0.35, -d * 0.18, 0.5, 0.5, 0.5, 0.0, "#9c7a52")
        add("wardrobe", "Wardrobe", w * 0.3, d * 0.3, 1.0, 2.0, 0.55, 0.0, "#8a6a48")

    elif room.kind == "living_room":
        sofa_w = min(2.4, w * 0.6)
        add("sofa", "Sofa", -w * 0.18, -d * 0.18, sofa_w, 0.85, 0.95, 0.0, "#7a6a55")
        add("coffee_table", "Coffee Table", -w * 0.18, d * 0.05, 1.2, 0.42, 0.7, 0.0, "#5a4734")
        add("tv_stand", "TV Stand", w * 0.3, d * 0.18, 1.6, 0.55, 0.4, 0.0, "#3a3a3a")

    elif room.kind == "kitchen":
        add("counter", "Counter", -w * 0.3, -d * 0.3, w * 0.55, 0.9, 0.6, 0.0, "#dfdfdf")
        add("island", "Island", 0, 0, min(2.0, w * 0.45), 0.9, min(1.0, d * 0.4), 0.0, "#caa478")
        add("fridge", "Refrigerator", w * 0.32, -d * 0.3, 0.8, 1.85, 0.7, 0.0, "#9a9a9a")

    elif room.kind == "dining_room":
        add("table", "Dining Table", 0, 0, min(2.0, w * 0.55), 0.75, min(1.0, d * 0.4), 0.0, "#7a5934")
        add("chair", "Chair", -0.9, 0, 0.45, 0.85, 0.45, 0.0, "#5a4734")
        add("chair", "Chair", 0.9, 0, 0.45, 0.85, 0.45, 0.0, "#5a4734")

    elif room.kind == "bathroom":
        add("vanity", "Vanity", -w * 0.3, -d * 0.3, min(1.2, w - 0.6), 0.9, 0.5, 0.0, "#caa478")
        add("toilet", "Toilet", w * 0.25, d * 0.25, 0.45, 0.78, 0.55, 0.0, "#dfdfdf")
        add("shower", "Shower", w * 0.3, -d * 0.3, 1.0, 2.0, 0.9, 0.0, "#9aa0a6")

    elif room.kind == "office":
        add("desk", "Desk", 0, -d * 0.2, min(1.5, w * 0.55), 0.74, 0.7, 0.0, "#5a4734")
        add("chair", "Office Chair", 0, d * 0.05, 0.6, 0.95, 0.6, 0.0, "#3a3a3a")
        add("shelf", "Shelf", w * 0.35, 0, 0.9, 1.85, 0.4, 0.0, "#8a6a48")

    elif room.kind == "garage":
        for i in range(2):  # up to two car silhouettes
            if w > 5.0 and i < 1:
                add("car", f"Car {i + 1}", (-1 if i == 0 else 1) * w * 0.18, 0, 1.9, 1.5, 4.4, 0.0, "#404040")
        add("workbench", "Workbench", -w * 0.32, d * 0.3, min(1.6, w * 0.4), 0.9, 0.6, 0.0, "#5a4734")

    elif room.kind == "laundry":
        add("washer", "Washer", -w * 0.25, 0, 0.7, 1.0, 0.65, 0.0, "#dfdfdf")
        add("dryer", "Dryer", w * 0.25, 0, 0.7, 1.0, 0.65, 0.0, "#dfdfdf")

    return items


# ---------------------------------------------------------------------------
# Top-level solve
# ---------------------------------------------------------------------------


def solve_floorplan(req: GenerateHouseRequest, program: Program) -> FloorPlan:
    ceiling_h = 2.7
    thickness = 0.18

    packed = pack_rooms(program)
    rooms: List[Room] = []
    packed_by_id: Dict[str, _PackedRoom] = {}
    for p in packed:
        room_id = _uid("r")
        rooms.append(
            Room(
                id=room_id,
                kind=p.program.kind,
                name=p.program.name,
                min=Vec2(x=p.x0, z=p.z0),
                max=Vec2(x=p.x1, z=p.z1),
                level=0,
                ceilingHeight=ceiling_h,
            )
        )
        packed_by_id[room_id] = p

    walls, openings = derive_walls_and_openings(rooms, packed_by_id, ceiling_h, thickness)

    furniture: List[FurnitureItem] = []
    for room in rooms:
        furniture.extend(_furniture_for(room))

    seed = req.seed if req.seed is not None else 0
    if program.source == "llm" and program.model:
        source_label = f"llm:{program.model}+templated_v1"
    elif program.source == "llm":
        source_label = "llm+templated_v1"
    else:
        source_label = "rules+templated_v1"
    return FloorPlan(
        version=1,
        meta=FloorPlanMeta(
            style=program.style,
            sqft=req.basics.sqft,
            floors=program.floors,
            generatedAt=datetime.now(timezone.utc).isoformat(),
            seed=seed,
            source=source_label,
        ),
        rooms=rooms,
        walls=walls,
        openings=openings,
        furniture=furniture,
    )

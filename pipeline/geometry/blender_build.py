"""Blender headless shell builder.

This script runs INSIDE Blender's Python interpreter -- never imported by
the FastAPI process. Spawn it from `plan_to_3d.py` with::

    blender --background --python pipeline/geometry/blender_build.py \\
            -- --plan /path/to/plan.json --out /path/to/shell.glb

It reads a Genesis FloorPlan (the same shape produced by /generate_house)
and builds:

  * a thin floor slab per room
  * an extruded wall mesh per Wall
  * a boolean-subtracted hole through each wall for every Opening
    (door / window / garage_door)
  * a simple gable roof over the footprint envelope

Then exports the whole thing as a glTF binary (.glb) suitable for
loading into the React/Three.js viewer (or Unreal Datasmith later).

Why boolean cuts (vs. translucent placeholder primitives in the
StudioObject layer): real openings let downstream renderers (Cycles,
Unreal Lumen) do correct daylighting, and let exporters round-trip to
IFC / FBX / OBJ for permits or visualization.

The script is intentionally pure-bpy: no third-party deps, so it runs
on any Blender 3.6+ install (including the bundled Python in the Mac
App Bundle and the apt-installed binary on Linux).
"""

# pylint: disable=import-error
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import bpy  # type: ignore  # provided by Blender
from mathutils import Vector  # type: ignore  # provided by Blender


# ---------------------------------------------------------------------------
# Argument parsing -- Blender swallows its own args; ours follow `--`.
# ---------------------------------------------------------------------------


def _user_args() -> list[str]:
    if "--" in sys.argv:
        return sys.argv[sys.argv.index("--") + 1 :]
    return []


def _parse() -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="blender_build")
    p.add_argument("--plan", required=True, help="Path to FloorPlan JSON.")
    p.add_argument("--out", required=True, help="Path to write the .glb to.")
    p.add_argument(
        "--ridge-height",
        type=float,
        default=2.0,
        help="Roof ridge above wall top (meters).",
    )
    p.add_argument(
        "--eave-overhang",
        type=float,
        default=0.4,
        help="Roof overhang past exterior walls (meters).",
    )
    return p.parse_args(_user_args())


# ---------------------------------------------------------------------------
# Scene setup
# ---------------------------------------------------------------------------


def reset_scene() -> None:
    """Wipe the default scene contents so we start from an empty stage."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # Z-up, +Y forward is the default; gltf exporter handles axis swap.


def make_material(name: str, rgb: tuple[float, float, float], roughness: float = 0.7,
                  metallic: float = 0.0) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
    return mat


# ---------------------------------------------------------------------------
# Primitive builders
# ---------------------------------------------------------------------------


def add_box(name: str, *, size: tuple[float, float, float],
            location: tuple[float, float, float],
            rotation_z: float = 0.0,
            material: bpy.types.Material | None = None) -> bpy.types.Object:
    """Create an axis-aligned cuboid centered at ``location``.

    ``size`` is (x, y, z) in meters. ``rotation_z`` is around the Z axis
    in radians, applied around the box center.
    """
    bpy.ops.mesh.primitive_cube_add(size=1.0, enter_editmode=False, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0], size[1], size[2])
    obj.rotation_euler[2] = rotation_z
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if material is not None:
        if obj.data.materials:
            obj.data.materials[0] = material
        else:
            obj.data.materials.append(material)
    return obj


def add_cylinder(name: str, *, radius: float, depth: float,
                 location: tuple[float, float, float],
                 rotation_euler: tuple[float, float, float] = (0.0, 0.0, 0.0),
                 material: bpy.types.Material | None = None,
                 vertices: int = 24) -> bpy.types.Object:
    """Create a cylinder (Z-aligned by default) at ``location``."""
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices, radius=radius, depth=depth, location=location,
    )
    obj = bpy.context.active_object
    obj.name = name
    obj.rotation_euler = rotation_euler
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if material is not None:
        if obj.data.materials:
            obj.data.materials[0] = material
        else:
            obj.data.materials.append(material)
    return obj


def boolean_difference(target: bpy.types.Object, cutter: bpy.types.Object) -> None:
    """Apply a Boolean DIFFERENCE modifier on ``target`` using ``cutter``."""
    mod = target.modifiers.new(name=f"cut_{cutter.name}", type="BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.object = cutter
    # `solver` defaults to 'EXACT' on modern Blender, which gives us
    # the best topology for clean openings.
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.modifier_apply(modifier=mod.name)


# ---------------------------------------------------------------------------
# Plan -> geometry
# ---------------------------------------------------------------------------


def palette_for(style: str) -> dict[str, bpy.types.Material]:
    style = (style or "modern").lower()
    presets = {
        "modern":        {"wall": (0.91, 0.91, 0.91), "floor": (0.22, 0.22, 0.22), "roof": (0.22, 0.22, 0.22)},
        "farmhouse":     {"wall": (0.95, 0.93, 0.89), "floor": (0.42, 0.29, 0.17), "roof": (0.22, 0.22, 0.22)},
        "mediterranean": {"wall": (0.95, 0.89, 0.81), "floor": (0.63, 0.36, 0.21), "roof": (0.55, 0.28, 0.17)},
        "spanish":       {"wall": (0.94, 0.88, 0.78), "floor": (0.54, 0.23, 0.11), "roof": (0.55, 0.28, 0.17)},
        "barndominium":  {"wall": (0.81, 0.81, 0.81), "floor": (0.29, 0.29, 0.29), "roof": (0.18, 0.18, 0.18)},
        "log-cabin":     {"wall": (0.66, 0.45, 0.27), "floor": (0.36, 0.23, 0.12), "roof": (0.30, 0.20, 0.13)},
        "ranch-house":   {"wall": (0.92, 0.85, 0.74), "floor": (0.48, 0.35, 0.20), "roof": (0.32, 0.22, 0.16)},
        "victorian":     {"wall": (0.86, 0.81, 0.88), "floor": (0.25, 0.16, 0.23), "roof": (0.24, 0.16, 0.20)},
        "contemporary":  {"wall": (0.93, 0.93, 0.93), "floor": (0.18, 0.18, 0.18), "roof": (0.18, 0.18, 0.18)},
    }
    p = presets.get(style, presets["modern"])
    mats = {
        "wall_ext": make_material("wall_ext", p["wall"], roughness=0.78),
        "wall_int": make_material("wall_int", p["wall"], roughness=0.85),
        "floor":    make_material("floor",    p["floor"], roughness=0.92),
        "roof":     make_material("roof",     p["roof"],  roughness=0.65),
        # --- Stock furniture materials (shared across all kinds). The
        # parametric furniture builders pull from this fixed set so the
        # whole scene exports with a small, consistent material count.
        "wood_warm":   make_material("wood_warm",   (0.45, 0.30, 0.18), roughness=0.55),
        "wood_dark":   make_material("wood_dark",   (0.22, 0.15, 0.10), roughness=0.55),
        "wood_light":  make_material("wood_light",  (0.78, 0.62, 0.42), roughness=0.55),
        "fabric":      make_material("fabric",      (0.50, 0.45, 0.40), roughness=0.92),
        "fabric_warm": make_material("fabric_warm", (0.65, 0.42, 0.30), roughness=0.92),
        "fabric_cool": make_material("fabric_cool", (0.30, 0.34, 0.42), roughness=0.92),
        "metal":       make_material("metal",       (0.70, 0.70, 0.72), roughness=0.30, metallic=0.85),
        "chrome":      make_material("chrome",      (0.90, 0.90, 0.92), roughness=0.10, metallic=1.00),
        "porcelain":   make_material("porcelain",   (0.96, 0.96, 0.96), roughness=0.18),
        "screen":      make_material("screen",      (0.05, 0.05, 0.06), roughness=0.20),
        "glass":       make_material("glass",       (0.85, 0.92, 0.96), roughness=0.05),
        "stone":       make_material("stone",       (0.78, 0.76, 0.72), roughness=0.65),
        "leather":     make_material("leather",     (0.18, 0.13, 0.10), roughness=0.55),
    }
    return mats


def build_floors(plan: dict, materials: dict) -> list[bpy.types.Object]:
    out: list[bpy.types.Object] = []
    for room in plan["rooms"]:
        cx = (room["min"]["x"] + room["max"]["x"]) / 2
        cy = (room["min"]["z"] + room["max"]["z"]) / 2
        w = room["max"]["x"] - room["min"]["x"]
        d = room["max"]["z"] - room["min"]["z"]
        # NOTE: Genesis FloorPlan uses XZ as the floor plane (Y up). In
        # Blender we use XY as the floor plane (Z up). So the floorplan's
        # `z` becomes Blender's `y`, and the slab thickness is on Z.
        slab = add_box(
            f"floor_{room['id']}",
            size=(w, d, 0.1),
            location=(cx, cy, -0.05),
            material=materials["floor"],
        )
        out.append(slab)
    return out


def build_walls_with_openings(plan: dict, materials: dict) -> list[bpy.types.Object]:
    """Create a wall mesh per Wall, then boolean-subtract each Opening."""
    out: list[bpy.types.Object] = []

    # Index openings by wall id for one O(1) lookup per wall.
    openings_by_wall: dict[str, list[dict]] = {}
    for op in plan["openings"]:
        openings_by_wall.setdefault(op["wallId"], []).append(op)

    for wall in plan["walls"]:
        ax, ay = wall["a"]["x"], wall["a"]["z"]
        bx, by = wall["b"]["x"], wall["b"]["z"]
        dx = bx - ax
        dy = by - ay
        length = math.hypot(dx, dy)
        if length < 1e-4:
            continue
        height = float(wall["height"])
        thickness = float(wall["thickness"])
        cx = (ax + bx) / 2
        cy = (ay + by) / 2
        rot_z = math.atan2(dy, dx)

        mat = materials["wall_ext"] if wall["exterior"] else materials["wall_int"]
        wobj = add_box(
            f"wall_{wall['id']}",
            size=(length, thickness, height),
            location=(cx, cy, height / 2),
            rotation_z=rot_z,
            material=mat,
        )

        # Subtract each opening on this wall.
        cutters_to_remove: list[bpy.types.Object] = []
        for op in openings_by_wall.get(wall["id"], []):
            offset = float(op["offset"])
            ow = float(op["width"])
            oh = float(op["height"])
            sill = float(op["sill"])
            # Center along the wall's local +X (a -> b direction).
            tx = dx / length
            ty = dy / length
            opening_center_x = ax + tx * (offset + ow / 2)
            opening_center_y = ay + ty * (offset + ow / 2)
            opening_center_z = sill + oh / 2
            cutter = add_box(
                f"cut_{op['id']}",
                # Slightly oversize on Y (thickness axis) so the boolean
                # subtraction is robust to floating-point coplanarity.
                size=(ow, thickness * 1.5, oh),
                location=(opening_center_x, opening_center_y, opening_center_z),
                rotation_z=rot_z,
            )
            boolean_difference(wobj, cutter)
            cutters_to_remove.append(cutter)

        # Cleanup cutter objects from the scene; geometry is already baked
        # into the wall via the applied modifier.
        for c in cutters_to_remove:
            bpy.data.objects.remove(c, do_unlink=True)

        out.append(wobj)
    return out


# ---------------------------------------------------------------------------
# Parametric furniture
# ---------------------------------------------------------------------------
#
# Each FurnitureItem.kind is mapped to a small builder that constructs
# a recognizable mesh from primitives. Designed as a swap-point: when
# we wire up TRELLIS or 3D-FUTURE retrieval later, the new path will
# return a list of glTF-imported objects with the same (location,
# rotation, scale) signature. Until then, parametric meshes give us
# real silhouettes in renders without any external assets or downloads.
#
# Coordinate convention:
#   FloorPlan stores furniture position as [x, y_height, z_floorplan]
#   and scale as [width, height_y, depth_z]. Blender uses Z-up, so
#   _xform() swaps y/z: Blender(x, y, z) = FloorPlan(x, z, y).


def _xform(item: dict) -> tuple[tuple[float, float, float], float, tuple[float, float, float]]:
    """Return ``(blender_location, rotation_z, blender_size)`` for an item."""
    px, py, pz = item["position"]
    sx, sy, sz = item["scale"]
    rot = item.get("rotation") or [0.0, 0.0, 0.0]
    # FloorPlan rotation is around the up axis (index 1, the Y axis in
    # FloorPlan). That maps to Blender's Z axis.
    rotation_z = float(rot[1])
    return (px, pz, py), rotation_z, (sx, sz, sy)


def _local_offset(rotation_z: float, dx: float, dy: float) -> tuple[float, float]:
    """Rotate a local (dx, dy) offset around Z so sub-parts follow item orientation."""
    c, s = math.cos(rotation_z), math.sin(rotation_z)
    return c * dx - s * dy, s * dx + c * dy


def _build_bed(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _cz), rz, (w, d, h) = _xform(item)
    out: list[bpy.types.Object] = []
    base_h = max(0.18, h * 0.32)
    mat_h = max(0.18, h * 0.45)
    head_h = h * 1.55  # taller than the bed itself
    # Frame (slightly taller than mattress base for a visible plinth).
    out.append(add_box("bed_frame",
        size=(w, d, base_h),
        location=(cx, cy, base_h / 2),
        rotation_z=rz, material=mats["wood_warm"]))
    # Mattress.
    out.append(add_box("bed_mattress",
        size=(w * 0.96, d * 0.96, mat_h),
        location=(cx, cy, base_h + mat_h / 2),
        rotation_z=rz, material=mats["fabric"]))
    # Headboard at -y end (in local coords).
    hb_dx, hb_dy = _local_offset(rz, 0.0, -d / 2 + 0.05)
    out.append(add_box("bed_headboard",
        size=(w, 0.10, head_h),
        location=(cx + hb_dx, cy + hb_dy, head_h / 2),
        rotation_z=rz, material=mats["wood_dark"]))
    # Pillows (two short cuboids at the head end).
    for sign in (-1, 1):
        pdx, pdy = _local_offset(rz, sign * w * 0.22, -d * 0.32)
        out.append(add_box(f"bed_pillow_{'l' if sign < 0 else 'r'}",
            size=(w * 0.36, d * 0.18, mat_h * 0.45),
            location=(cx + pdx, cy + pdy, base_h + mat_h + mat_h * 0.22),
            rotation_z=rz, material=mats["porcelain"]))
    return out


def _build_nightstand(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    out: list[bpy.types.Object] = []
    out.append(add_box("ns_body",
        size=(w, d, h * 0.95),
        location=(cx, cy, h * 0.475),
        rotation_z=rz, material=mats["wood_warm"]))
    out.append(add_box("ns_top",
        size=(w * 1.05, d * 1.05, max(0.02, h * 0.05)),
        location=(cx, cy, h - h * 0.025),
        rotation_z=rz, material=mats["wood_dark"]))
    return out


def _build_wardrobe(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    out = [add_box("wardrobe_body",
        size=(w, d, h),
        location=(cx, cy, h / 2),
        rotation_z=rz, material=mats["wood_dark"])]
    # Door split: two thin panels on the front face.
    half_w = w / 2
    front_dy = d / 2 + 0.005
    for sign, label in ((-1, "l"), (1, "r")):
        ddx, ddy = _local_offset(rz, sign * half_w / 2, front_dy)
        out.append(add_box(f"wardrobe_door_{label}",
            size=(half_w * 0.94, 0.02, h * 0.94),
            location=(cx + ddx, cy + ddy, h / 2),
            rotation_z=rz, material=mats["wood_warm"]))
    return out


def _build_sofa(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    out: list[bpy.types.Object] = []
    seat_h = max(0.30, h * 0.42)
    arm_h = h * 0.62
    back_h = h
    # Base / seat.
    out.append(add_box("sofa_base",
        size=(w, d, seat_h),
        location=(cx, cy, seat_h / 2),
        rotation_z=rz, material=mats["fabric_warm"]))
    # Backrest at -d.
    back_dx, back_dy = _local_offset(rz, 0.0, -d / 2 + 0.10)
    out.append(add_box("sofa_back",
        size=(w, 0.20, back_h),
        location=(cx + back_dx, cy + back_dy, back_h / 2),
        rotation_z=rz, material=mats["fabric_warm"]))
    # Arms.
    for sign, label in ((-1, "l"), (1, "r")):
        adx, ady = _local_offset(rz, sign * (w / 2 - 0.10), 0.0)
        out.append(add_box(f"sofa_arm_{label}",
            size=(0.20, d, arm_h),
            location=(cx + adx, cy + ady, arm_h / 2),
            rotation_z=rz, material=mats["fabric_warm"]))
    return out


def _build_coffee_table(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    top_h = max(0.04, h * 0.12)
    out = [add_box("ct_top",
        size=(w, d, top_h),
        location=(cx, cy, h - top_h / 2),
        rotation_z=rz, material=mats["wood_dark"])]
    leg_h = h - top_h
    leg_w = 0.06
    for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        ldx, ldy = _local_offset(rz, sx * (w / 2 - leg_w), sy * (d / 2 - leg_w))
        out.append(add_box(f"ct_leg_{sx}_{sy}",
            size=(leg_w, leg_w, leg_h),
            location=(cx + ldx, cy + ldy, leg_h / 2),
            rotation_z=rz, material=mats["metal"]))
    return out


def _build_tv_stand(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    out: list[bpy.types.Object] = []
    out.append(add_box("tv_stand",
        size=(w, d, h),
        location=(cx, cy, h / 2),
        rotation_z=rz, material=mats["wood_dark"]))
    # TV screen above the stand, leaning slightly off the back.
    tv_h = h * 1.4
    tv_w = w * 0.85
    tv_z = h + tv_h / 2
    tdx, tdy = _local_offset(rz, 0.0, -d / 2 + 0.04)
    out.append(add_box("tv_screen",
        size=(tv_w, 0.05, tv_h),
        location=(cx + tdx, cy + tdy, tv_z),
        rotation_z=rz, material=mats["screen"]))
    return out


def _build_dining_table(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    top_h = 0.06
    out = [add_box("dt_top",
        size=(w, d, top_h),
        location=(cx, cy, h - top_h / 2),
        rotation_z=rz, material=mats["wood_warm"])]
    leg_h = h - top_h
    leg_w = 0.08
    for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        ldx, ldy = _local_offset(rz, sx * (w / 2 - leg_w * 1.5), sy * (d / 2 - leg_w * 1.5))
        out.append(add_box(f"dt_leg_{sx}_{sy}",
            size=(leg_w, leg_w, leg_h),
            location=(cx + ldx, cy + ldy, leg_h / 2),
            rotation_z=rz, material=mats["wood_dark"]))
    return out


def _build_chair(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    seat_h = max(0.42, h * 0.50)
    out: list[bpy.types.Object] = []
    out.append(add_box("chair_seat",
        size=(w, d, 0.05),
        location=(cx, cy, seat_h),
        rotation_z=rz, material=mats["wood_dark"]))
    # Backrest at -d.
    bdx, bdy = _local_offset(rz, 0.0, -d / 2 + 0.03)
    out.append(add_box("chair_back",
        size=(w, 0.04, h - seat_h),
        location=(cx + bdx, cy + bdy, seat_h + (h - seat_h) / 2),
        rotation_z=rz, material=mats["wood_warm"]))
    # 4 legs.
    leg_w = 0.05
    for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        ldx, ldy = _local_offset(rz, sx * (w / 2 - leg_w), sy * (d / 2 - leg_w))
        out.append(add_box(f"chair_leg_{sx}_{sy}",
            size=(leg_w, leg_w, seat_h),
            location=(cx + ldx, cy + ldy, seat_h / 2),
            rotation_z=rz, material=mats["wood_dark"]))
    return out


def _build_office_chair(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    seat_h = max(0.45, h * 0.50)
    out: list[bpy.types.Object] = []
    out.append(add_box("oc_seat",
        size=(w * 0.95, d * 0.95, 0.06),
        location=(cx, cy, seat_h),
        rotation_z=rz, material=mats["fabric_cool"]))
    bdx, bdy = _local_offset(rz, 0.0, -d / 2 + 0.04)
    out.append(add_box("oc_back",
        size=(w * 0.85, 0.05, h - seat_h),
        location=(cx + bdx, cy + bdy, seat_h + (h - seat_h) / 2),
        rotation_z=rz, material=mats["fabric_cool"]))
    # Single column + 5-star base footprint approximated by a low cylinder.
    out.append(add_cylinder("oc_column",
        radius=max(0.03, w * 0.07), depth=seat_h - 0.05,
        location=(cx, cy, (seat_h - 0.05) / 2),
        material=mats["chrome"]))
    out.append(add_cylinder("oc_base",
        radius=max(0.22, w * 0.45), depth=0.05,
        location=(cx, cy, 0.025),
        material=mats["chrome"]))
    return out


def _build_counter(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    body_h = h - 0.04
    out = [add_box("counter_body",
        size=(w, d, body_h),
        location=(cx, cy, body_h / 2),
        rotation_z=rz, material=mats["wood_light"])]
    out.append(add_box("counter_top",
        size=(w * 1.02, d * 1.02, 0.04),
        location=(cx, cy, body_h + 0.02),
        rotation_z=rz, material=mats["stone"]))
    return out


def _build_island(item: dict, mats: dict) -> list[bpy.types.Object]:
    return _build_counter(item, mats)


def _build_fridge(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    out = [add_box("fridge_body",
        size=(w, d, h),
        location=(cx, cy, h / 2),
        rotation_z=rz, material=mats["chrome"])]
    # Door split line (thin gap material).
    gdx, gdy = _local_offset(rz, 0.0, d / 2 + 0.005)
    out.append(add_box("fridge_seam",
        size=(w * 0.94, 0.01, h * 0.55),
        location=(cx + gdx, cy + gdy, h * 0.62),
        rotation_z=rz, material=mats["screen"]))
    return out


def _build_vanity(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    body_h = h - 0.04
    out = [add_box("vanity_body",
        size=(w, d, body_h),
        location=(cx, cy, body_h / 2),
        rotation_z=rz, material=mats["wood_warm"])]
    out.append(add_box("vanity_top",
        size=(w * 1.02, d * 1.02, 0.04),
        location=(cx, cy, body_h + 0.02),
        rotation_z=rz, material=mats["stone"]))
    # Sink bowl approximated by a shallow cylinder cut into the top
    # (no boolean here -- visual proxy is enough at panel scale).
    out.append(add_cylinder("vanity_basin",
        radius=min(w, d) * 0.28, depth=0.05,
        location=(cx, cy, body_h + 0.045),
        material=mats["porcelain"]))
    return out


def _build_toilet(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    bowl_h = h * 0.45
    out = [add_cylinder("toilet_bowl",
        radius=min(w, d) * 0.38, depth=bowl_h,
        location=(cx, cy, bowl_h / 2),
        material=mats["porcelain"])]
    # Tank at -d.
    tdx, tdy = _local_offset(rz, 0.0, -d * 0.30)
    tank_h = h - bowl_h
    out.append(add_box("toilet_tank",
        size=(w * 0.9, d * 0.30, tank_h),
        location=(cx + tdx, cy + tdy, bowl_h + tank_h / 2),
        rotation_z=rz, material=mats["porcelain"]))
    return out


def _build_shower(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    # Glass enclosure: a hollow-looking arrangement of 3 thin panels +
    # a tile floor base. Without boolean we approximate by 3 thin walls
    # forming an open-front enclosure.
    out: list[bpy.types.Object] = [add_box("shower_floor",
        size=(w, d, 0.04),
        location=(cx, cy, 0.02),
        rotation_z=rz, material=mats["stone"])]
    # Back wall + two side panels (front is open).
    bdx, bdy = _local_offset(rz, 0.0, -d / 2 + 0.02)
    out.append(add_box("shower_back",
        size=(w, 0.04, h),
        location=(cx + bdx, cy + bdy, h / 2),
        rotation_z=rz, material=mats["glass"]))
    for sign, label in ((-1, "l"), (1, "r")):
        sdx, sdy = _local_offset(rz, sign * (w / 2 - 0.02), -d * 0.10)
        out.append(add_box(f"shower_side_{label}",
            size=(0.04, d * 0.85, h),
            location=(cx + sdx, cy + sdy, h / 2),
            rotation_z=rz, material=mats["glass"]))
    return out


def _build_desk(item: dict, mats: dict) -> list[bpy.types.Object]:
    return _build_dining_table(item, mats)


def _build_shelf(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    out: list[bpy.types.Object] = []
    # Back panel + 4 horizontal shelves.
    out.append(add_box("shelf_back",
        size=(w, 0.03, h),
        location=(cx, cy + d / 2 - 0.015, h / 2),
        rotation_z=rz, material=mats["wood_dark"]))
    levels = 4
    shelf_t = 0.03
    for i in range(levels):
        z = (h / (levels - 1)) * i + shelf_t / 2
        if i == levels - 1:
            z = h - shelf_t / 2
        out.append(add_box(f"shelf_lvl_{i}",
            size=(w, d, shelf_t),
            location=(cx, cy, z),
            rotation_z=rz, material=mats["wood_warm"]))
    # Side panels.
    for sign, label in ((-1, "l"), (1, "r")):
        sdx, sdy = _local_offset(rz, sign * (w / 2 - 0.015), 0.0)
        out.append(add_box(f"shelf_side_{label}",
            size=(0.03, d, h),
            location=(cx + sdx, cy + sdy, h / 2),
            rotation_z=rz, material=mats["wood_dark"]))
    return out


def _build_car(item: dict, mats: dict) -> list[bpy.types.Object]:
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    body_h = h * 0.55
    out: list[bpy.types.Object] = [add_box("car_body",
        size=(w, d, body_h),
        location=(cx, cy, body_h / 2),
        rotation_z=rz, material=mats["fabric_cool"])]
    # Greenhouse / cabin.
    out.append(add_box("car_cabin",
        size=(w * 0.7, d * 0.55, h - body_h),
        location=(cx, cy, body_h + (h - body_h) / 2),
        rotation_z=rz, material=mats["glass"]))
    # 4 wheels (cylinders aligned along the lateral axis -> rotate around X).
    wheel_r = h * 0.20
    wheel_d = w * 0.10
    for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        wdx, wdy = _local_offset(rz, sx * (w / 2 - wheel_d * 0.5), sy * (d / 2 - wheel_r * 1.2))
        out.append(add_cylinder(f"car_wheel_{sx}_{sy}",
            radius=wheel_r, depth=wheel_d,
            location=(cx + wdx, cy + wdy, wheel_r),
            rotation_euler=(0.0, math.pi / 2, rz),
            material=mats["screen"]))
    return out


def _build_workbench(item: dict, mats: dict) -> list[bpy.types.Object]:
    return _build_dining_table(item, mats)


def _build_appliance(item: dict, mats: dict) -> list[bpy.types.Object]:
    """Generic boxy appliance (washer / dryer)."""
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    out = [add_box(f"app_body_{item.get('id', '')}",
        size=(w, d, h),
        location=(cx, cy, h / 2),
        rotation_z=rz, material=mats["chrome"])]
    # Round door on the front.
    fdx, fdy = _local_offset(rz, 0.0, d / 2 + 0.02)
    out.append(add_cylinder("app_door",
        radius=min(w, h) * 0.30, depth=0.04,
        location=(cx + fdx, cy + fdy, h * 0.55),
        rotation_euler=(math.pi / 2, 0.0, rz),
        material=mats["screen"]))
    return out


def _build_default_box(item: dict, mats: dict) -> list[bpy.types.Object]:
    """Fallback: a styled cuboid for kinds we don't have a specific builder for."""
    (cx, cy, _), rz, (w, d, h) = _xform(item)
    color = item.get("color")
    if color:
        # Use a one-off material for the explicit color request rather than
        # a stock palette swatch, so the editor's color choice survives.
        try:
            r = int(color[1:3], 16) / 255.0
            g = int(color[3:5], 16) / 255.0
            b = int(color[5:7], 16) / 255.0
            mat = make_material(f"box_{item.get('id', '')}", (r, g, b), roughness=0.6)
        except Exception:
            mat = mats["wood_warm"]
    else:
        mat = mats["wood_warm"]
    return [add_box(f"box_{item.get('id', '')}",
        size=(w, d, h),
        location=(cx, cy, h / 2),
        rotation_z=rz, material=mat)]


# Dispatch table: FurnitureItem.kind -> builder. Anything not listed falls
# back to _build_default_box, which preserves the previous box behavior.
FURNITURE_BUILDERS: dict[str, callable] = {
    "bed":           _build_bed,
    "nightstand":    _build_nightstand,
    "wardrobe":      _build_wardrobe,
    "sofa":          _build_sofa,
    "coffee_table":  _build_coffee_table,
    "tv_stand":      _build_tv_stand,
    "table":         _build_dining_table,
    "chair":         _build_chair,
    "counter":       _build_counter,
    "island":        _build_island,
    "fridge":        _build_fridge,
    "vanity":        _build_vanity,
    "toilet":        _build_toilet,
    "shower":        _build_shower,
    "desk":          _build_desk,
    "shelf":         _build_shelf,
    "car":           _build_car,
    "workbench":     _build_workbench,
    "washer":        _build_appliance,
    "dryer":         _build_appliance,
}


# ---------------------------------------------------------------------------
# Asset retrieval: import a GLB and place it as a FurnitureItem
# ---------------------------------------------------------------------------


def _world_aabb(objs: list[bpy.types.Object]) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """Return ``(min_xyz, max_xyz)`` of the union of object world bounding boxes."""
    inf = float("inf")
    lo = [inf, inf, inf]
    hi = [-inf, -inf, -inf]
    for obj in objs:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            wp = obj.matrix_world @ Vector(corner)
            for i in range(3):
                if wp[i] < lo[i]:
                    lo[i] = wp[i]
                if wp[i] > hi[i]:
                    hi[i] = wp[i]
    if lo[0] == inf:
        return (0.0, 0.0, 0.0), (0.0, 0.0, 0.0)
    return (lo[0], lo[1], lo[2]), (hi[0], hi[1], hi[2])


def _build_from_asset(item: dict) -> list[bpy.types.Object]:
    """Import the GLB referenced by ``item['assetPath']`` and place it.

    Imports into a fresh empty parent so we can transform the entire
    asset as a unit. Scales the asset's world bounding box to match
    the FurnitureItem's ``scale`` (target dimensions in meters), then
    moves the bottom face to floor level so the item sits on the slab
    regardless of how the source GLB was authored. Falls back to the
    parametric builder by raising on any import / placement failure
    -- the caller catches and recovers.
    """
    asset_path = item.get("assetPath")
    if not asset_path or not os.path.isfile(asset_path):
        raise FileNotFoundError(f"asset path missing or not a file: {asset_path!r}")

    (cx, cy, _), rz, (target_w, target_d, target_h) = _xform(item)

    # Snapshot existing top-level objects so we can identify which
    # objects the gltf import created (Blender's import_scene.gltf
    # doesn't return them directly).
    pre_keys = {o.name for o in bpy.context.scene.objects}

    suffix = os.path.splitext(asset_path)[1].lower()
    try:
        if suffix in (".gltf", ".glb"):
            bpy.ops.import_scene.gltf(filepath=asset_path)
        elif suffix == ".obj":
            bpy.ops.import_scene.obj(filepath=asset_path)
        elif suffix == ".fbx":
            bpy.ops.import_scene.fbx(filepath=asset_path)
        else:
            raise ValueError(f"unsupported asset extension: {suffix}")
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"glTF import failed for {asset_path}: {exc}") from exc

    new_objs = [o for o in bpy.context.scene.objects if o.name not in pre_keys]
    if not new_objs:
        raise RuntimeError("import returned no objects")

    mesh_objs = [o for o in new_objs if o.type == "MESH"]
    if not mesh_objs:
        # Some glTFs nest meshes under empties; that's fine, just keep
        # the empties with their parented mesh children.
        mesh_objs = [o for o in new_objs if any(c.type == "MESH" for c in o.children_recursive)]
        if not mesh_objs:
            for o in new_objs:
                bpy.data.objects.remove(o, do_unlink=True)
            raise RuntimeError("import yielded no mesh geometry")

    # Group everything under a fresh empty so we can transform as a unit.
    group = bpy.data.objects.new(f"asset_{item.get('id', '')}", None)
    bpy.context.collection.objects.link(group)
    for o in new_objs:
        if o.parent is None:
            o.parent = group

    # Compute the imported asset's world AABB BEFORE we move it.
    bpy.context.view_layer.update()
    lo, hi = _world_aabb(mesh_objs)
    src_w = max(0.001, hi[0] - lo[0])
    src_d = max(0.001, hi[1] - lo[1])
    src_h = max(0.001, hi[2] - lo[2])

    # Center of source bbox (to translate so origin sits at floor center).
    src_cx = (lo[0] + hi[0]) / 2
    src_cy = (lo[1] + hi[1]) / 2
    src_lo_z = lo[2]

    # Target dimensions: from the FurnitureItem scale tuple. Per-axis
    # scale so we honor the architect's chosen footprint exactly.
    sx = max(0.001, float(target_w)) / src_w
    sy = max(0.001, float(target_d)) / src_d
    sz = max(0.001, float(target_h)) / src_h

    # Two-step transform: first translate the imported pivot so the
    # asset's bbox center sits at the world origin (at the bottom on Z),
    # then scale, then rotate around Z, then translate to the FurnitureItem
    # position. The empty parent carries all of this.
    group.location = (-src_cx, -src_cy, -src_lo_z)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    group.select_set(True)
    for o in new_objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = group
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    # Now scale + rotate + translate to place.
    group.scale = (sx, sy, sz)
    group.rotation_euler = (0.0, 0.0, float(rz))
    group.location = (cx, cy, 0.0)
    return [group] + new_objs


def build_furniture(plan: dict, materials: dict) -> list[bpy.types.Object]:
    """Build every FurnitureItem in the plan into Blender geometry.

    Per-item priority:
      1. Asset retrieval -- if ``item['assetPath']`` is set AND the file
         exists, import the GLB and scale it to the FurnitureItem's
         dimensions. This is what the asset-retrieval agent enables.
      2. Parametric builder dispatched on ``kind`` -- the original
         free-of-charge fallback that always works.
      3. Default styled cuboid -- for unknown kinds, or when steps 1
         and 2 both raise.

    Each step's failure falls through to the next so the scene never
    silently drops content.
    """
    out: list[bpy.types.Object] = []
    for item in plan.get("furniture", []) or []:
        kind = item.get("kind", "")
        builder = FURNITURE_BUILDERS.get(kind, _build_default_box)

        # Step 1: asset retrieval.
        if item.get("assetPath"):
            try:
                out.extend(_build_from_asset(item))
                continue
            except Exception as exc:  # noqa: BLE001
                print(
                    f"[blender_build] asset import failed for {kind} "
                    f"({item.get('assetPath')}): {exc}; falling back to parametric"
                )

        # Step 2: parametric builder.
        try:
            out.extend(builder(item, materials))
            continue
        except Exception as exc:  # noqa: BLE001
            print(f"[blender_build] furniture builder failed for {kind}: {exc}")

        # Step 3: default cuboid. This builder is itself near-bulletproof
        # but wrap defensively in case bpy.ops misbehaves.
        try:
            out.extend(_build_default_box(item, materials))
        except Exception as exc:  # noqa: BLE001
            print(f"[blender_build] default builder also failed for {kind}: {exc}")
    return out


def build_roof(plan: dict, materials: dict) -> bpy.types.Object | None:
    """Simple gable roof spanning the footprint envelope.

    Computes the AABB of all rooms, extends by ``eave_overhang``, then
    builds a triangular prism whose ridge runs along the longer axis.
    """
    if not plan["rooms"]:
        return None
    min_x = min(r["min"]["x"] for r in plan["rooms"])
    max_x = max(r["max"]["x"] for r in plan["rooms"])
    min_y = min(r["min"]["z"] for r in plan["rooms"])
    max_y = max(r["max"]["z"] for r in plan["rooms"])
    args = _parse_cached()
    overhang = args.eave_overhang
    ridge_h = args.ridge_height
    min_x -= overhang
    max_x += overhang
    min_y -= overhang
    max_y += overhang

    width = max_x - min_x
    depth = max_y - min_y

    # Wall top reference: use the highest wall height, fallback 2.7.
    wall_top = max((float(w["height"]) for w in plan["walls"]), default=2.7)
    ridge_axis = "x" if width >= depth else "y"

    mesh = bpy.data.meshes.new("roof")
    obj = bpy.data.objects.new("roof", mesh)
    bpy.context.collection.objects.link(obj)

    cz_top = wall_top + ridge_h
    cz_eave = wall_top
    if ridge_axis == "x":
        # Ridge along x at y = (min_y + max_y) / 2.
        midy = (min_y + max_y) / 2
        verts = [
            (min_x, min_y, cz_eave),  # 0
            (max_x, min_y, cz_eave),  # 1
            (max_x, max_y, cz_eave),  # 2
            (min_x, max_y, cz_eave),  # 3
            (min_x, midy,  cz_top),   # 4 (ridge near)
            (max_x, midy,  cz_top),   # 5 (ridge far)
        ]
        faces = [
            (0, 1, 5, 4),  # front slope
            (3, 2, 5, 4),  # back slope (flipped winding)
            (0, 4, 3),     # gable end (left)
            (1, 2, 5),     # gable end (right)
        ]
    else:
        midx = (min_x + max_x) / 2
        verts = [
            (min_x, min_y, cz_eave),  # 0
            (max_x, min_y, cz_eave),  # 1
            (max_x, max_y, cz_eave),  # 2
            (min_x, max_y, cz_eave),  # 3
            (midx,  min_y, cz_top),   # 4 (ridge near)
            (midx,  max_y, cz_top),   # 5 (ridge far)
        ]
        faces = [
            (0, 1, 4),
            (1, 2, 5, 4),
            (2, 3, 5),
            (3, 0, 4, 5),
        ]

    mesh.from_pydata(verts, [], [face for face in faces])
    mesh.update(calc_edges=True)

    if obj.data.materials:
        obj.data.materials[0] = materials["roof"]
    else:
        obj.data.materials.append(materials["roof"])
    return obj


# A lazy cache so build_roof can read --ridge-height etc. without
# re-parsing argv (which is fine because args don't change per run).
_args_cached: argparse.Namespace | None = None


def _parse_cached() -> argparse.Namespace:
    global _args_cached
    if _args_cached is None:
        _args_cached = _parse()
    return _args_cached


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def export_glb(out_path: str) -> None:
    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        # Apply transforms; embed materials/images.
        export_apply=True,
        export_yup=True,
        export_extras=False,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    args = _parse_cached()
    with open(args.plan, "r", encoding="utf-8") as fh:
        plan = json.load(fh)
    if int(plan.get("version", 0)) != 1:
        print(f"[blender_build] unsupported FloorPlan version: {plan.get('version')}", file=sys.stderr)
        return 2

    reset_scene()
    materials = palette_for(plan.get("meta", {}).get("style", "modern"))

    build_floors(plan, materials)
    build_walls_with_openings(plan, materials)
    furniture_objs = build_furniture(plan, materials)
    build_roof(plan, materials)

    export_glb(args.out)

    # Stats line for the parent process to parse.
    print(json.dumps({
        "ok": True,
        "out": os.path.abspath(args.out),
        "rooms": len(plan["rooms"]),
        "walls": len(plan["walls"]),
        "openings": len(plan["openings"]),
        "furniture_items": len(plan.get("furniture", []) or []),
        "furniture_objects": len(furniture_objs),
    }))
    return 0


if __name__ == "__main__":
    try:
        rc = main()
    except Exception as exc:  # noqa: BLE001 -- surface to parent
        print(f"[blender_build] FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        rc = 1
    sys.exit(rc)

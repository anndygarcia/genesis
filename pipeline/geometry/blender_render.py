"""Blender headless Cycles render pass.

Sibling to ``blender_build.py``: instead of exporting a GLB, this script
sets up cameras + lighting and renders one PNG per requested view using
Cycles (with OpenImageDenoise for clean output at low sample counts).

Spawn with::

    blender --background --python pipeline/geometry/blender_render.py \\
            -- --plan /path/to/plan.json --out-dir /path/to/job/dir \\
               --views exterior_front,exterior_aerial,interior_living,interior_master \\
               --samples 32 --resolution 1280 720

Why rebuild the scene from the plan JSON instead of importing the GLB
the build pass already produced:

  * The plan carries semantic info (room kinds, names, AABBs) that lets
    us place interior cameras intelligently. Re-importing the GLB would
    require parsing geometry to figure out where the master bedroom is.
  * Imported glTF materials lose Blender's procedural sky link; rebuild
    keeps materials in the principled-BSDF graph the build pass set up.
  * Build is fast (~1s on a typical home), so rebuilding before render
    costs almost nothing and keeps the renderer self-contained.

The build helpers are imported from the sibling ``blender_build`` module;
we add the script directory to ``sys.path`` because Blender doesn't do
that automatically when launched with ``--python``.
"""

# pylint: disable=import-error,wrong-import-position
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import bpy  # type: ignore  # provided by Blender

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

import blender_build as bb  # noqa: E402


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _user_args() -> list[str]:
    if "--" in sys.argv:
        return sys.argv[sys.argv.index("--") + 1 :]
    return []


def _parse() -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="blender_render")
    p.add_argument("--plan", required=True)
    p.add_argument("--out-dir", required=True, help="Directory to write render PNGs into.")
    p.add_argument(
        "--views",
        default="exterior_front,exterior_aerial,interior_living,interior_master",
        help="Comma-separated list of view names. See ALL_VIEWS.",
    )
    p.add_argument("--samples", type=int, default=32, help="Cycles render samples.")
    p.add_argument("--resolution", nargs=2, type=int, default=[1280, 720], metavar=("W", "H"))
    p.add_argument("--ridge-height", type=float, default=2.0)
    p.add_argument("--eave-overhang", type=float, default=0.4)
    p.add_argument("--use-gpu", action="store_true", help="Try to enable a GPU compute device for Cycles.")
    return p.parse_args(_user_args())


ALL_VIEWS = ("exterior_front", "exterior_aerial", "interior_living", "interior_master")


# ---------------------------------------------------------------------------
# Scene construction
# ---------------------------------------------------------------------------


def _footprint(plan: dict) -> tuple[float, float, float, float]:
    """Return (min_x, min_y, max_x, max_y) of the room AABBs in Blender XY."""
    xs0 = [r["min"]["x"] for r in plan["rooms"]]
    ys0 = [r["min"]["z"] for r in plan["rooms"]]
    xs1 = [r["max"]["x"] for r in plan["rooms"]]
    ys1 = [r["max"]["z"] for r in plan["rooms"]]
    return min(xs0), min(ys0), max(xs1), max(ys1)


def _wall_top(plan: dict) -> float:
    return max((float(w["height"]) for w in plan["walls"]), default=2.7)


def _room_by_kind(plan: dict, *kinds: str) -> dict | None:
    for r in plan["rooms"]:
        if r["kind"] in kinds:
            return r
    return None


def _add_sun_and_sky() -> None:
    """One sun light + a procedural sky world background."""
    # Sun: elevated, slightly south-west of origin for warm raking light.
    bpy.ops.object.light_add(type="SUN", location=(8, -8, 14))
    sun = bpy.context.active_object
    sun.data.energy = 4.5
    sun.rotation_euler = (math.radians(55), 0.0, math.radians(35))

    # World: Nishita sky for free PBR-correct daylight.
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    bg = nt.nodes.new("ShaderNodeBackground")
    sky = nt.nodes.new("ShaderNodeTexSky")
    out = nt.nodes.new("ShaderNodeOutputWorld")
    sky.sky_type = "NISHITA"
    sky.sun_elevation = math.radians(45)
    sky.sun_rotation = math.radians(220)
    sky.air_density = 1.0
    sky.dust_density = 1.0
    bg.inputs["Strength"].default_value = 0.9
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])


def _add_camera(name: str, location: tuple[float, float, float],
                target: tuple[float, float, float],
                lens_mm: float = 24.0) -> bpy.types.Object:
    """Create a camera at ``location`` looking at ``target``."""
    cam_data = bpy.data.cameras.new(name=name)
    cam_data.lens = lens_mm
    cam_obj = bpy.data.objects.new(name, cam_data)
    bpy.context.collection.objects.link(cam_obj)
    cam_obj.location = location

    # Aim using a TRACK_TO constraint pointed at an empty placed at target.
    target_empty = bpy.data.objects.new(f"{name}_target", None)
    bpy.context.collection.objects.link(target_empty)
    target_empty.location = target
    track = cam_obj.constraints.new(type="TRACK_TO")
    track.target = target_empty
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"
    return cam_obj


# ---------------------------------------------------------------------------
# Camera placement strategies
# ---------------------------------------------------------------------------


def _camera_for(view: str, plan: dict) -> bpy.types.Object | None:
    min_x, min_y, max_x, max_y = _footprint(plan)
    cx = (min_x + max_x) / 2
    cy = (min_y + max_y) / 2
    width = max_x - min_x
    depth = max_y - min_y
    diag = math.hypot(width, depth)
    wall_top = _wall_top(plan)

    if view == "exterior_front":
        # Front of the home: pick the side closest to the entry room.
        entry = _room_by_kind(plan, "entry") or plan["rooms"][0]
        ecx = (entry["min"]["x"] + entry["max"]["x"]) / 2
        ecy = (entry["min"]["z"] + entry["max"]["z"]) / 2
        # Move outward along the axis from envelope center toward the entry.
        dx = ecx - cx
        dy = ecy - cy
        dist = max(0.5, math.hypot(dx, dy))
        nx, ny = dx / dist, dy / dist
        stand_off = max(diag * 0.65, 7.0)
        cam_x = cx + nx * (max(width, depth) / 2 + stand_off)
        cam_y = cy + ny * (max(width, depth) / 2 + stand_off)
        return _add_camera(
            "cam_exterior_front",
            location=(cam_x, cam_y, 1.7),
            target=(cx, cy, wall_top * 0.55),
            lens_mm=28,
        )

    if view == "exterior_aerial":
        # Look-down from a corner of the lot.
        cam_x = max_x + max(width, 6.0) * 0.6
        cam_y = min_y - max(depth, 6.0) * 0.6
        cam_z = wall_top + max(diag, 8.0) * 0.55
        return _add_camera(
            "cam_exterior_aerial",
            location=(cam_x, cam_y, cam_z),
            target=(cx, cy, 0.5),
            lens_mm=24,
        )

    if view == "interior_living":
        room = _room_by_kind(plan, "living_room") or plan["rooms"][0]
        rcx = (room["min"]["x"] + room["max"]["x"]) / 2
        rcy = (room["min"]["z"] + room["max"]["z"]) / 2
        rw = room["max"]["x"] - room["min"]["x"]
        rd = room["max"]["z"] - room["min"]["z"]
        # Stand near a corner facing the opposite corner for a wide view.
        cam_x = room["min"]["x"] + rw * 0.18
        cam_y = room["min"]["z"] + rd * 0.18
        return _add_camera(
            "cam_interior_living",
            location=(cam_x, cam_y, 1.55),
            target=(rcx + rw * 0.2, rcy + rd * 0.2, 1.4),
            lens_mm=18,
        )

    if view == "interior_master":
        room = _room_by_kind(plan, "master_bedroom", "bedroom") or plan["rooms"][-1]
        rcx = (room["min"]["x"] + room["max"]["x"]) / 2
        rcy = (room["min"]["z"] + room["max"]["z"]) / 2
        rw = room["max"]["x"] - room["min"]["x"]
        rd = room["max"]["z"] - room["min"]["z"]
        cam_x = room["min"]["x"] + rw * 0.15
        cam_y = room["min"]["z"] + rd * 0.15
        return _add_camera(
            "cam_interior_master",
            location=(cam_x, cam_y, 1.55),
            target=(rcx + rw * 0.25, rcy + rd * 0.25, 1.3),
            lens_mm=20,
        )

    return None


# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------


def _configure_cycles(samples: int, resolution: tuple[int, int], use_gpu: bool) -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = max(8, int(samples))
    scene.cycles.use_denoising = True
    # Prefer OpenImageDenoise (free, CPU/GPU, ships with Blender).
    try:
        scene.cycles.denoiser = "OPENIMAGEDENOISE"
    except Exception:  # pragma: no cover - older Blender
        pass

    scene.render.resolution_x = int(resolution[0])
    scene.render.resolution_y = int(resolution[1])
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.view_transform = "AgX"  # Modern filmic-like default.

    if use_gpu:
        prefs = bpy.context.preferences
        try:
            cycles_prefs = prefs.addons["cycles"].preferences
            # Try CUDA / OPTIX / METAL / HIP in order of typical performance.
            for backend in ("OPTIX", "CUDA", "METAL", "HIP", "ONEAPI"):
                try:
                    cycles_prefs.compute_device_type = backend
                    cycles_prefs.refresh_devices()
                    if any(d.use for d in cycles_prefs.devices):
                        break
                except Exception:
                    continue
            for d in cycles_prefs.devices:
                d.use = True
            scene.cycles.device = "GPU"
        except Exception:
            scene.cycles.device = "CPU"
    else:
        scene.cycles.device = "CPU"


def _render_view(camera: bpy.types.Object, out_path: str) -> None:
    scene = bpy.context.scene
    scene.camera = camera
    scene.render.filepath = out_path
    bpy.ops.render.render(write_still=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    args = _parse()
    with open(args.plan, "r", encoding="utf-8") as fh:
        plan = json.load(fh)
    if int(plan.get("version", 0)) != 1:
        print(f"[blender_render] unsupported FloorPlan version: {plan.get('version')}", file=sys.stderr)
        return 2

    requested = [v.strip() for v in args.views.split(",") if v.strip()]
    unknown = [v for v in requested if v not in ALL_VIEWS]
    if unknown:
        print(f"[blender_render] unknown view(s): {unknown}; valid: {ALL_VIEWS}", file=sys.stderr)
        return 2

    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    # Re-use build helpers to construct the scene.
    bb.reset_scene()
    materials = bb.palette_for(plan.get("meta", {}).get("style", "modern"))
    bb.build_floors(plan, materials)
    bb.build_walls_with_openings(plan, materials)
    bb.build_furniture(plan, materials)
    # Rebuilding roof needs the shared lazy args; reuse our parsed args.
    bb._args_cached = argparse.Namespace(
        plan=args.plan,
        out="(unused)",
        ridge_height=args.ridge_height,
        eave_overhang=args.eave_overhang,
    )
    bb.build_roof(plan, materials)

    _add_sun_and_sky()
    _configure_cycles(args.samples, tuple(args.resolution), args.use_gpu)

    rendered: list[dict] = []
    for view in requested:
        cam = _camera_for(view, plan)
        if cam is None:
            print(f"[blender_render] skipping unknown view {view}", file=sys.stderr)
            continue
        out_path = os.path.join(out_dir, f"render_{view}.png")
        _render_view(cam, out_path)
        rendered.append({"view": view, "path": out_path})

    # Summary line for the parent process to parse.
    print(json.dumps({
        "ok": True,
        "renders": rendered,
        "samples": args.samples,
        "resolution": list(args.resolution),
    }))
    return 0


if __name__ == "__main__":
    try:
        rc = main()
    except Exception as exc:  # noqa: BLE001
        print(f"[blender_render] FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        rc = 1
    sys.exit(rc)

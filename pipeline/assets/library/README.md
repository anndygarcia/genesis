# Asset library

Drop `.glb` / `.gltf` files in this directory and register them in
`../manifest.json` so the Cycles renders use them instead of parametric
primitives.

## Manifest entry shape

```json
{
  "id":          "modern_sofa_01",
  "kind":        "sofa",
  "path":        "library/modern_sofa_01.glb",
  "dimensions":  [2.20, 0.85, 0.95],
  "style_tags":  ["modern", "contemporary", "minimalist"],
  "license":     "CC0",
  "source":      "Quaternius - Stylized Furniture Pack",
  "preview":     "library/modern_sofa_01.png",
  "description": "Low-profile fabric sofa with chrome legs."
}
```

`dimensions` is `[width, height, depth]` in meters and should match the
GLB's bounding box. The retrieval scorer uses dimension proximity to
pick the best asset for each FurnitureItem, so accurate dimensions
materially improve match quality.

`style_tags` aligns with the architect's vocabulary:
`modern`, `contemporary`, `farmhouse`, `mediterranean`, `spanish`,
`victorian`, `barndominium`, `log-cabin`, `ranch-house`, `craftsman`,
`colonial`, `tudor`, `mid-century`, `scandinavian`, `industrial`,
`minimalist`. Style overlap adds up to a 50% bonus on top of the
dimension-proximity score; perfect dimension match without style overlap
beats a tag-matching but mis-sized asset.

## Recommended free sources

- **Quaternius** — CC0 stylized furniture: <https://quaternius.com/>
- **KayKit** — CC0 modular packs: <https://kaylousberg.itch.io/>
- **Poly Pizza** — Mixed CC0/CC-BY by various creators: <https://poly.pizza/>
- **glTF Sample Assets** — Apache 2.0 reference models: <https://github.com/KhronosGroup/glTF-Sample-Assets>

## Larger datasets

- **3D-FUTURE** — 16,563 industrial-grade indoor furniture meshes,
  curated by Alibaba. Academic license; requires registration. Use
  the included CSV (`model_info.json`) and a small adapter script to
  generate a Genesis manifest entry per row.
- **3D-FRONT** — 18,968 furnished indoor scenes paired with 3D-FUTURE.
  Useful if you want to retrieve full *room layouts* rather than
  per-item furniture.

## TRELLIS on-demand generation

Set `GENESIS_TRELLIS_ENDPOINT` (placeholder; not yet wired) to a
Microsoft TRELLIS HTTP service to generate-on-demand from text or an
image. The catalog will cache returned GLBs by content hash and add
entries automatically.

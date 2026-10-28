# apply_changes cheatsheet

The server fills in every field Excalidraw needs (version, seed, index, fonts, …). Give it only what matters.

## Ops

```json
{ "ops": [
  { "op": "create", "type": "rectangle", "id": "auth", "label": "Auth Service", "x": 400, "y": 120, "width": 180, "height": 80 },
  { "op": "create", "type": "ellipse", "id": "start", "label": "Start", "x": 100, "y": 130 },
  { "op": "create", "type": "arrow", "start": "start", "end": "auth", "label": "login" },
  { "op": "create", "type": "text", "text": "Why sync?", "x": 400, "y": 240, "strokeColor": "#e03131" },
  { "op": "update", "id": "auth", "patch": { "label": "Auth (OIDC)", "backgroundColor": "#d0ebff" }, "expectedVersion": 3 },
  { "op": "delete", "id": "old-box" }
], "frameId": null }
```

- `id` is optional on create; give one so later ops in the same call (and arrows) can refer to it.
- `frameId`: `null` → no frame, for what the user asked for; omit → "Claude proposal" frame in free space, for your own proposals; `"<id>"` → an existing frame.
- `color` sets the default stroke for this call.
- Arrows with `start`/`end` are routed edge to edge. Without them give `x`, `y` and `points: [[0,0],[dx,dy]]`.

## Useful fields

| Field | Values |
|---|---|
| `type` | `rectangle`, `ellipse`, `diamond`, `text`, `arrow`, `line`, `frame` |
| `x`, `y`, `width`, `height` | canvas pixels; defaults 160×80 |
| `strokeColor`, `backgroundColor` | hex, or `transparent` |
| `fillStyle` | `solid`, `hachure`, `cross-hatch` |
| `strokeStyle` | `solid`, `dashed`, `dotted` |
| `roundness` | `null` = sharp, `{ "type": 3 }` = rounded |
| `fontSize` | text: 16 small, 20 normal, 28 heading |
| `fontFamily` | text: 6 Nunito (default), 2 Helvetica, 3 Cascadia (code), 5 Excalifont (hand-drawn) |
| `startArrowhead`, `endArrowhead` | `null`, `arrow`, `triangle`, `dot`, `bar` |
| `link` | URL or `/d/<diagramId>#<elementId>` to link to another board |
| `name` | frame title |

## Layout

- Leave about 60px between shapes and 120px between columns.
- Read `get_scene_summary` first and place new things in empty space (right of or below the existing drawing).

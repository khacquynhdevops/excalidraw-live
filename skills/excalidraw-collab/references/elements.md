# apply_changes cheatsheet

The server fills in every field Excalidraw needs (version, seed, index, fonts, …). Give it only what matters.

## Ops

```json
{ "ops": [
  { "op": "create", "type": "rectangle", "id": "auth", "label": "Auth Service", "x": 400, "y": 120, "width": 180, "height": 80 },
  { "op": "create", "type": "ellipse", "id": "start", "label": "Start", "x": 100, "y": 130 },
  { "op": "create", "type": "arrow", "start": "start", "end": "auth", "label": "login" },
  { "op": "create", "type": "text", "text": "Why sync?", "x": 400, "y": 240, "strokeColor": "#e03131" },
  { "op": "update", "id": "auth", "patch": { "label": "Auth (OIDC)", "backgroundColor": "#e5dbff", "strokeColor": "#5f3dc4" }, "expectedVersion": 3 },
  { "op": "delete", "id": "old-box" }
], "frameId": null }
```

- `id` is optional on create; give one so later ops in the same call (and arrows) can refer to it.
- `frameId`: `null` → no frame, for what the user asked for; omit → "Claude proposal" frame in free space, for your own proposals; `"<id>"` → an existing frame.
- `color` sets the default stroke for this call; without it the stroke is neutral `#343a40`.
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

## Colours

Excalidraw's own palette: a light fill with a dark stroke of the same hue. `open_diagram` says which meaning gets which colour on the board's kind.

| Name | Fill | Stroke | Typical meaning |
|---|---|---|---|
| blue | `#d0ebff` | `#1864ab` | person, actor, requirement |
| green | `#d3f9d8` | `#2b8a3e` | UI, deliverable, done, healthy |
| yellow | `#fff3bf` | `#e67700` | goal, decision, gateway, gate |
| violet | `#e5dbff` | `#5f3dc4` | service, system in scope, process |
| orange | `#ffe8cc` | `#d9480f` | data store, activity |
| pink | `#ffdeeb` | `#a61e4d` | queue, broker, event |
| grey | `#e9ecef` | `#495057` | external (dashed), start/end, infrastructure |
| red | `#ffe3e3` | `#e03131` | risk, problem, failure, threat — nothing else |
| white | `#ffffff` | `#343a40` | plain step, entity, story |

Neutral ink: arrows `#868e96`, text and frames `#343a40`. Use `fillStyle: "solid"`. External things also get `strokeStyle: "dashed"`; the one focus of the board gets `strokeWidth: 4`.

Legend, when the board uses 3 or more fill colours (one swatch and one text per colour, inside a frame to the right of the drawing):

```json
{ "ops": [
  { "op": "create", "type": "frame", "id": "legend", "name": "Legend", "x": 1400, "y": 0, "width": 220, "height": 150 },
  { "op": "create", "type": "rectangle", "x": 1420, "y": 30, "width": 30, "height": 20, "backgroundColor": "#e5dbff", "strokeColor": "#5f3dc4", "fillStyle": "solid" },
  { "op": "create", "type": "text", "text": "service", "x": 1460, "y": 30, "fontSize": 16 },
  { "op": "create", "type": "rectangle", "x": 1420, "y": 70, "width": 30, "height": 20, "backgroundColor": "#ffe8cc", "strokeColor": "#d9480f", "fillStyle": "solid" },
  { "op": "create", "type": "text", "text": "data store", "x": 1460, "y": 70, "fontSize": 16 }
], "frameId": "legend" }
```

## Layout

- Read `get_scene_summary` first and place new things in empty space (right of or below the existing drawing).
- The server grows a shape too small for its label and keeps the label centred when the shape moves or resizes.
- Keep arrow labels short (`HTTPS 443`, `publishes`); put longer explanations in a note beside the arrow.
- `apply_changes` ends with `layout:` lines for problems around what it wrote; fix them before going on. After a large drawing, call `get_scene_summary` and fix every item under `layout issues` before you report it done.

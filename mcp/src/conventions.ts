// How to draw each kind of diagram. open_diagram and create_diagram return the
// line for the board's kind, so the agent sees it right before drawing; `free`
// and kinds without a line get none.
import type { DiagramKind } from '@excalidraw-live/shared';

const c4 = 'rectangle = system/container, frame per boundary, arrow label = protocol or intent';
const process = 'ellipse = start/end, rectangle = step, diamond = decision, arrows left→right';

export const CONVENTIONS: Partial<Record<DiagramKind, string>> = {
  journey: process,
  flow: process,
  overview: 'impact map: goal → actors → impacts → deliverables as columns left→right, arrows between them',
  'c4-context': c4,
  'c4-container': c4,
  'c4-component': c4,
  'story-map': 'activities in a row at the top (backbone), tasks under them, stories below; one horizontal frame per release slice',
  sequence: 'participants in a row at the top, lines down, numbered arrow labels',
  erd: 'rectangle per entity with fields as text, arrow label = cardinality',
  state: 'rounded rectangles, arrows labelled with the event',
  'threat-model': 'ellipse = process, rectangle = external entity, text between two horizontal lines = data store, dashed frame = trust boundary, arrow = data flow, red text = STRIDE threat beside the element',
  pipeline: 'rectangle = stage or job, left→right; diamond = gate or manual approval; frame per environment in promotion order',
  deployment: 'solid frame = deployment node, nested (region › cluster › node); rectangle = container instance named as on `c4-container`; ellipse = infrastructure node (LB, DNS, firewall); arrow label = protocol/port',
  network: 'solid frame = network/subnet/zone, arrow = allowed traffic labelled with port; separate boards for north-south and east-west traffic',
  'health-model': 'critical user flow at the top, services below, infrastructure at the bottom, arrows = depends on; green/amber/red = healthy/degraded/unhealthy'
};

export function conventionLine(kind: DiagramKind): string | undefined {
  const c = CONVENTIONS[kind];
  return c && `${kind} conventions: ${c}`;
}

// What the agent needs right before drawing a kind of board, returned by
// open_diagram and create_diagram (`free` gets none). The model already knows
// these notations, so this names the notation and leaves the drawing to it;
// it adds only what the model cannot know: our colours, the few house rules,
// and mistakes seen in user feedback.
//
// Colour encodes what a thing is (Excalidraw's open-color palette: light fill,
// dark stroke of the same hue), so the same kind of thing looks the same on
// every board. Red is kept for risks and problems.
import type { DiagramKind } from '@excalidraw-live/shared';

export const PALETTE = {
  blue: ['#d0ebff', '#1864ab'],
  green: ['#d3f9d8', '#2b8a3e'],
  yellow: ['#fff3bf', '#e67700'],
  violet: ['#e5dbff', '#5f3dc4'],
  orange: ['#ffe8cc', '#d9480f'],
  pink: ['#ffdeeb', '#a61e4d'],
  grey: ['#e9ecef', '#495057'],
  red: ['#ffe3e3', '#e03131'],
  white: ['#ffffff', '#343a40']
} as const;

type Colour = keyof typeof PALETTE;

interface Convention {
  // The notation an expert would draw this kind in.
  notation: string;
  // Where we differ from that notation, or how it maps onto frames.
  house?: string;
  // What each colour means on this kind of board.
  colours: [meaning: string, colour: Colour][];
  // Mistakes seen in user feedback, each with why it hurts the reader.
  // Remove one once models stop making it.
  avoid?: string[];
}

const c4Colours: Convention['colours'] = [
  ['person', 'blue'], ['web/mobile UI', 'green'], ['gateway/edge', 'yellow'], ['service', 'violet'],
  ['data store', 'orange'], ['queue/broker', 'pink'], ['external system (dashed)', 'grey']
];

export const CONVENTIONS: Partial<Record<DiagramKind, Convention>> = {
  overview: {
    notation: 'impact mapping (goal → actors → impacts → deliverables)',
    colours: [['goal', 'yellow'], ['actor', 'blue'], ['impact', 'violet'], ['deliverable', 'green']]
  },
  'story-map': {
    notation: 'Jeff Patton user story mapping',
    house: 'one horizontal frame per release slice',
    colours: [['activity', 'orange'], ['task', 'yellow'], ['story', 'white']]
  },
  journey: {
    notation: 'customer journey mapping',
    colours: [['action', 'white'], ['touchpoint', 'blue'], ['pain point', 'red'], ['opportunity', 'green']]
  },
  flow: {
    notation: 'flowcharts (BPMN-style swimlanes when several actors take part)',
    house: 'one frame per lane',
    colours: [['start/end', 'grey'], ['step', 'white'], ['decision', 'yellow'], ['error path', 'red']]
  },
  'c4-context': {
    notation: 'the C4 model (system context level)',
    colours: [['person', 'blue'], ['system in scope', 'violet'], ['external system (dashed)', 'grey']]
  },
  'c4-container': {
    notation: 'the C4 model (container level)',
    house: 'a dashed frame is the system boundary',
    colours: c4Colours,
    // 2026-10-29, dev session feedback on a c4-container board.
    avoid: ['external systems far from the container that calls them: the arrow then cuts across other boxes and the reader loses it']
  },
  'c4-component': {
    notation: 'the C4 model (component level)',
    house: 'the frame is the container being detailed',
    colours: [['component', 'violet'], ['other container', 'grey'], ['data store', 'orange'], ['queue/broker', 'pink'], ['external system (dashed)', 'grey']]
  },
  sequence: {
    notation: 'UML sequence diagrams',
    house: 'participants coloured as on c4-container',
    colours: c4Colours
  },
  erd: {
    notation: 'entity-relationship modelling with cardinality on the relationships',
    house: 'aggregates grouped in frames',
    colours: [['aggregate root', 'violet'], ['entity', 'white'], ['lookup/reference', 'grey']]
  },
  state: {
    notation: 'UML state machines',
    colours: [['initial/final', 'grey'], ['state', 'white'], ['error state', 'red']]
  },
  wireframe: {
    notation: 'low-fidelity wireframing',
    house: 'one frame per screen, arrows between frames for navigation',
    colours: [['placeholder', 'grey'], ['primary action', 'blue'], ['note', 'yellow']]
  },
  timeline: {
    notation: 'goal-oriented product roadmaps',
    colours: [['done', 'green'], ['planned', 'white'], ['goal', 'yellow'], ['at risk', 'red']]
  },
  'test-map': {
    notation: 'requirements traceability (requirement → tests, by test level)',
    house: 'one frame per test level',
    colours: [['requirement', 'blue'], ['test', 'violet'], ['passing', 'green'], ['gap or failing', 'red']]
  },
  pipeline: {
    notation: 'CI/CD pipeline diagrams with gates',
    house: 'one frame per environment, in promotion order',
    colours: [['stage', 'white'], ['gate/approval', 'yellow'], ['environment frame', 'grey'], ['failure path', 'red']]
  },
  deployment: {
    notation: 'C4 deployment diagrams',
    house: 'nested frames for deployment nodes; container names as on c4-container',
    colours: [['container instance', 'violet'], ['data store', 'orange'], ['infrastructure node', 'grey'], ['external (dashed)', 'grey']]
  },
  network: {
    notation: 'network topology diagrams',
    house: 'one frame per network/subnet/zone',
    colours: [['host/service', 'white'], ['internet/external (dashed)', 'grey'], ['edge/firewall', 'yellow'], ['denied traffic (dashed)', 'red']]
  },
  'health-model': {
    notation: 'health modelling (user flow → services → infrastructure dependencies)',
    colours: [['healthy', 'green'], ['degraded', 'yellow'], ['unhealthy', 'red'], ['unknown', 'grey']]
  },
  'threat-model': {
    notation: 'data-flow diagrams with trust boundaries and STRIDE',
    house: 'a dashed frame is a trust boundary; each threat is a note beside its element with the STRIDE letter',
    colours: [['process', 'violet'], ['external entity', 'grey'], ['data store', 'orange'], ['threat', 'red']]
  }
};

export function conventionLine(kind: DiagramKind): string | undefined {
  const c = CONVENTIONS[kind];
  if (!c) return undefined;
  const colours = c.colours.map(([meaning, name]) => `${meaning} ${PALETTE[name][0]}/${PALETTE[name][1]}`).join(', ');
  return [
    `${kind}: draw it as an expert in ${c.notation} would, for a reader who has not seen it before.`,
    c.house && ` Here: ${c.house}.`,
    ` Fill/stroke: ${colours}. Arrows #868e96, text and frames #343a40.`,
    c.avoid && ` Avoid ${c.avoid.join('; ')}.`
  ].filter(Boolean).join('');
}

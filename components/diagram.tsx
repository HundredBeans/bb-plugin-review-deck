// Diagrams drawn as plain SVG.
//
// No charting library: shipping one would bloat the bundle, and a review
// diagram only needs two shapes. Everything is painted with `currentColor` on
// top of a BB theme class, so both diagram kinds follow the active theme.
import { useMemo } from "react";
import type {
  Diagram,
  DiagramTone,
  FlowDiagram,
  FlowEdge,
  SequenceDiagram,
} from "@/lib/deck-schema";
import { cn } from "@/lib/utils";

interface ToneStyle {
  fill: string;
  fillOpacity: number;
  stroke: string;
  dash?: string;
}

const TONES: Record<DiagramTone, ToneStyle> = {
  default: { fill: "text-card", fillOpacity: 1, stroke: "text-border" },
  added: { fill: "text-primary", fillOpacity: 0.12, stroke: "text-primary" },
  changed: {
    fill: "text-primary",
    fillOpacity: 0.06,
    stroke: "text-primary",
    dash: "5 3",
  },
  removed: {
    fill: "text-destructive",
    fillOpacity: 0.1,
    stroke: "text-destructive",
  },
  external: {
    fill: "text-muted",
    fillOpacity: 1,
    stroke: "text-border",
    dash: "3 3",
  },
};

/** Rough pixel width of a string at the given font size. */
function textWidth(text: string, size: number): number {
  return text.length * size * 0.58;
}

function clip(text: string, width: number, size: number): string {
  // The epsilon matters: widthOf() sizes a box from this same estimate, so
  // without it a label that exactly fits loses its last character.
  const max = Math.max(3, Math.floor(width / (size * 0.58) + 1e-6));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

interface Placed {
  id: string;
  label: string;
  note?: string;
  tone: DiagramTone;
  x: number;
  y: number;
  w: number;
  h: number;
}

const LABEL_SIZE = 12;
const NOTE_SIZE = 10;
const PAD = 12;

function layoutFlow(diagram: FlowDiagram) {
  const hasNote = diagram.nodes.some(
    (node) => (node.note ?? "").trim() !== "",
  );
  const nodeHeight = hasNote ? 50 : 34;
  const known = new Set(diagram.nodes.map((node) => node.id));
  const edges = diagram.edges.filter(
    (edge) => known.has(edge.from) && known.has(edge.to),
  );

  // Depth-first search marks the edges that close a cycle. A "retry" edge
  // pointing back upstream must not push its target below the node it feeds,
  // so layering ignores those and only the drawing keeps them.
  const outgoing = new Map<string, FlowEdge[]>();
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }
  const backEdges = new Set<FlowEdge>();
  const state = new Map<string, "open" | "done">();
  const visit = (id: string) => {
    state.set(id, "open");
    for (const edge of outgoing.get(id) ?? []) {
      const seen = state.get(edge.to);
      if (seen === "open") backEdges.add(edge);
      else if (seen === undefined) visit(edge.to);
    }
    state.set(id, "done");
  };
  for (const node of diagram.nodes) {
    if (!state.has(node.id)) visit(node.id);
  }
  const forward = edges.filter((edge) => !backEdges.has(edge));

  // Longest-path layering over the remaining acyclic edges.
  const layer = new Map(diagram.nodes.map((node) => [node.id, 0]));
  for (let round = 0; round < diagram.nodes.length; round += 1) {
    let moved = false;
    for (const edge of forward) {
      const want = (layer.get(edge.from) ?? 0) + 1;
      if ((layer.get(edge.to) ?? 0) < want) {
        layer.set(edge.to, want);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const byLayer = new Map<number, typeof diagram.nodes>();
  for (const node of diagram.nodes) {
    const index = layer.get(node.id) ?? 0;
    const bucket = byLayer.get(index) ?? [];
    bucket.push(node);
    byLayer.set(index, bucket);
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b);

  const widthOf = (node: (typeof diagram.nodes)[number]) =>
    Math.min(
      230,
      Math.max(
        112,
        textWidth(node.label, LABEL_SIZE) + PAD * 2,
        textWidth(node.note ?? "", NOTE_SIZE) + PAD * 2,
      ),
    );

  const gap = 22;
  const layerGap = diagram.direction === "right" ? 74 : 56;
  const placed: Placed[] = [];

  if (diagram.direction === "right") {
    let x = 0;
    const heights = layers.map(
      (index) =>
        (byLayer.get(index) ?? []).length * nodeHeight +
        Math.max(0, (byLayer.get(index) ?? []).length - 1) * gap,
    );
    const tallest = Math.max(...heights, nodeHeight);
    layers.forEach((index, position) => {
      const nodes = byLayer.get(index) ?? [];
      const columnWidth = Math.max(...nodes.map(widthOf));
      let y = (tallest - (heights[position] ?? 0)) / 2;
      for (const node of nodes) {
        placed.push({
          id: node.id,
          label: node.label,
          note: node.note,
          tone: node.tone,
          x,
          y,
          w: columnWidth,
          h: nodeHeight,
        });
        y += nodeHeight + gap;
      }
      x += columnWidth + layerGap;
    });
  } else {
    const widths = layers.map((index) => {
      const nodes = byLayer.get(index) ?? [];
      return (
        nodes.reduce((total, node) => total + widthOf(node), 0) +
        Math.max(0, nodes.length - 1) * gap
      );
    });
    const widest = Math.max(...widths, 120);
    layers.forEach((index, position) => {
      const nodes = byLayer.get(index) ?? [];
      let x = (widest - (widths[position] ?? 0)) / 2;
      const y = position * (nodeHeight + layerGap);
      for (const node of nodes) {
        const w = widthOf(node);
        placed.push({
          id: node.id,
          label: node.label,
          note: node.note,
          tone: node.tone,
          x,
          y,
          w,
          h: nodeHeight,
        });
        x += w + gap;
      }
    });
  }

  const width = Math.max(...placed.map((node) => node.x + node.w), 120);
  const height = Math.max(...placed.map((node) => node.y + node.h), 60);
  return { placed, edges, width, height, vertical: diagram.direction !== "right" };
}

type Heading = "down" | "up" | "right" | "left";

function arrowHead(x: number, y: number, heading: Heading): string {
  const w = 5;
  const l = 8;
  switch (heading) {
    case "down":
      return `${x},${y} ${x - w},${y - l} ${x + w},${y - l}`;
    case "up":
      return `${x},${y} ${x - w},${y + l} ${x + w},${y + l}`;
    case "right":
      return `${x},${y} ${x - l},${y - w} ${x - l},${y + w}`;
    default:
      return `${x},${y} ${x + l},${y - w} ${x + l},${y + w}`;
  }
}

function FlowView({ diagram }: { diagram: FlowDiagram }) {
  const layout = useMemo(() => layoutFlow(diagram), [diagram]);
  const { placed, edges, vertical } = layout;
  const index = new Map(placed.map((node) => [node.id, node]));
  const margin = 8;
  const width = layout.width + margin * 2;
  const height = layout.height + margin * 2;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="h-auto max-w-full"
      role="img"
      aria-label={diagram.title ?? "Diagram of the change"}
    >
      <g transform={`translate(${margin} ${margin})`}>
        {edges.map((edge, position) => {
          const from = index.get(edge.from);
          const to = index.get(edge.to);
          if (from === undefined || to === undefined) return null;
          // A feedback edge runs against the flow. Bowing it out to one side
          // keeps it off the forward edge it would otherwise sit on top of.
          const back = vertical ? to.y <= from.y : to.x <= from.x;
          const start = back
            ? vertical
              ? { x: from.x + from.w, y: from.y + from.h / 2 }
              : { x: from.x + from.w / 2, y: from.y + from.h }
            : vertical
              ? { x: from.x + from.w / 2, y: from.y + from.h }
              : { x: from.x + from.w, y: from.y + from.h / 2 };
          const end = back
            ? vertical
              ? { x: to.x + to.w + 9, y: to.y + to.h / 2 }
              : { x: to.x + to.w / 2, y: to.y + to.h + 9 }
            : vertical
              ? { x: to.x + to.w / 2, y: to.y - 9 }
              : { x: to.x - 9, y: to.y + to.h / 2 };
          const heading: Heading = back
            ? vertical
              ? "left"
              : "up"
            : vertical
              ? "down"
              : "right";
          const bow = 34;
          const span = vertical ? end.y - start.y : end.x - start.x;
          const bend = Math.max(18, Math.abs(span) / 2);
          const c1 = back
            ? vertical
              ? { x: start.x + bow, y: start.y }
              : { x: start.x, y: start.y + bow }
            : vertical
              ? { x: start.x, y: start.y + bend }
              : { x: start.x + bend, y: start.y };
          const c2 = back
            ? vertical
              ? { x: end.x + bow, y: end.y }
              : { x: end.x, y: end.y + bow }
            : vertical
              ? { x: end.x, y: end.y - bend }
              : { x: end.x - bend, y: end.y };
          // Halfway along the gap between the two boxes. The bezier midpoint
          // would sit on top of a node whenever the curve doubles back.
          // Halfway along the gap between the two boxes; a feedback edge puts
          // its label out on the bow so it does not land on a node.
          const mid = back
            ? {
                x: (start.x + end.x) / 2 + (vertical ? bow * 0.75 : 0),
                y: (start.y + end.y) / 2 + (vertical ? 0 : bow * 0.75),
              }
            : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
          const label = (edge.label ?? "").trim();
          return (
            <g key={`${edge.from}-${edge.to}-${position}`}>
              <path
                d={`M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.4}
                strokeDasharray={edge.style === "dashed" ? "4 3" : undefined}
                className="text-muted-foreground"
              />
              <polygon
                points={arrowHead(
                  heading === "down"
                    ? end.x
                    : heading === "right"
                      ? end.x + 9
                      : heading === "left"
                        ? end.x - 9
                        : end.x,
                  heading === "down"
                    ? end.y + 9
                    : heading === "up"
                      ? end.y - 9
                      : end.y,
                  heading,
                )}
                fill="currentColor"
                className="text-muted-foreground"
              />
              {label === "" ? null : (
                <>
                  <rect
                    x={mid.x - textWidth(label, 10) / 2 - 4}
                    y={mid.y - 8}
                    width={textWidth(label, 10) + 8}
                    height={15}
                    rx={3}
                    fill="currentColor"
                    className="text-background"
                  />
                  <text
                    x={mid.x}
                    y={mid.y + 3}
                    textAnchor="middle"
                    fontSize={10}
                    fill="currentColor"
                    className="text-muted-foreground"
                  >
                    {label}
                  </text>
                </>
              )}
            </g>
          );
        })}
        {placed.map((node) => {
          const tone = TONES[node.tone] ?? TONES.default;
          const hasNote = (node.note ?? "").trim() !== "";
          return (
            <g key={node.id}>
              <rect
                x={node.x}
                y={node.y}
                width={node.w}
                height={node.h}
                rx={7}
                fill="currentColor"
                fillOpacity={tone.fillOpacity}
                className={tone.fill}
              />
              <rect
                x={node.x}
                y={node.y}
                width={node.w}
                height={node.h}
                rx={7}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.4}
                strokeDasharray={tone.dash}
                className={tone.stroke}
              />
              <text
                x={node.x + node.w / 2}
                y={node.y + (hasNote ? 21 : node.h / 2 + 4)}
                textAnchor="middle"
                fontSize={LABEL_SIZE}
                fontWeight={500}
                fill="currentColor"
                className="text-foreground"
              >
                {clip(node.label, node.w - PAD * 2, LABEL_SIZE)}
              </text>
              {hasNote ? (
                <text
                  x={node.x + node.w / 2}
                  y={node.y + 37}
                  textAnchor="middle"
                  fontSize={NOTE_SIZE}
                  fill="currentColor"
                  className="text-muted-foreground"
                >
                  {clip(node.note ?? "", node.w - PAD * 2, NOTE_SIZE)}
                </text>
              ) : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Sequence
// ---------------------------------------------------------------------------

function SequenceView({ diagram }: { diagram: SequenceDiagram }) {
  const columnWidth = Math.max(
    132,
    ...diagram.actors.map((actor) => textWidth(actor.label, 11) + 26),
    ...diagram.steps.map((step) => textWidth(step.label, 10) + 30),
  );
  const headHeight = 30;
  const stepGap = 36;
  const top = headHeight + 26;
  const width = columnWidth * diagram.actors.length;
  const height = top + diagram.steps.length * stepGap + 18;
  const centre = (id: string) => {
    const position = diagram.actors.findIndex((actor) => actor.id === id);
    return (position < 0 ? 0 : position) * columnWidth + columnWidth / 2;
  };
  const margin = 8;

  return (
    <svg
      viewBox={`0 0 ${width + margin * 2} ${height + margin * 2}`}
      width={width + margin * 2}
      height={height + margin * 2}
      className="h-auto max-w-full"
      role="img"
      aria-label={diagram.title ?? "Sequence of calls"}
    >
      <g transform={`translate(${margin} ${margin})`}>
        {diagram.actors.map((actor, position) => {
          const tone = TONES[actor.tone] ?? TONES.default;
          const x = position * columnWidth + 10;
          const w = columnWidth - 20;
          return (
            <g key={actor.id}>
              <rect
                x={x}
                y={0}
                width={w}
                height={headHeight}
                rx={6}
                fill="currentColor"
                fillOpacity={tone.fillOpacity}
                className={tone.fill}
              />
              <rect
                x={x}
                y={0}
                width={w}
                height={headHeight}
                rx={6}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.4}
                strokeDasharray={tone.dash}
                className={tone.stroke}
              />
              <text
                x={x + w / 2}
                y={19}
                textAnchor="middle"
                fontSize={11}
                fontWeight={500}
                fill="currentColor"
                className="text-foreground"
              >
                {clip(actor.label, w - 12, 11)}
              </text>
              <line
                x1={x + w / 2}
                y1={headHeight}
                x2={x + w / 2}
                y2={height}
                stroke="currentColor"
                strokeWidth={1}
                strokeDasharray="3 4"
                className="text-border"
              />
            </g>
          );
        })}
        {diagram.steps.map((step, position) => {
          const y = top + position * stepGap;
          const from = centre(step.from);
          const to = centre(step.to);
          const tone = step.changed ? "text-primary" : "text-muted-foreground";
          const dash = step.style === "return" ? "5 3" : undefined;
          if (step.from === step.to) {
            const loop = 26;
            return (
              <g key={position}>
                <path
                  d={`M ${from} ${y} h ${loop} v 14 h ${-loop}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.4}
                  strokeDasharray={dash}
                  className={tone}
                />
                <polygon
                  points={`${from},${y + 14} ${from + 8},${y + 10} ${from + 8},${y + 18}`}
                  fill="currentColor"
                  className={tone}
                />
                <text
                  x={from + loop + 8}
                  y={y + 3}
                  fontSize={10}
                  fill="currentColor"
                  className={step.changed ? "text-primary" : "text-foreground"}
                >
                  {clip(step.label, columnWidth, 10)}
                </text>
              </g>
            );
          }
          const forward = to > from;
          const tip = forward ? to - 6 : to + 6;
          return (
            <g key={position}>
              <line
                x1={from}
                y1={y}
                x2={tip}
                y2={y}
                stroke="currentColor"
                strokeWidth={step.changed ? 1.8 : 1.4}
                strokeDasharray={dash}
                className={tone}
              />
              <polygon
                points={
                  forward
                    ? `${to},${y} ${to - 8},${y - 4} ${to - 8},${y + 4}`
                    : `${to},${y} ${to + 8},${y - 4} ${to + 8},${y + 4}`
                }
                fill="currentColor"
                className={tone}
              />
              <text
                x={(from + to) / 2}
                y={y - 6}
                textAnchor="middle"
                fontSize={10}
                fill="currentColor"
                className={step.changed ? "text-primary" : "text-foreground"}
              >
                {clip(step.label, Math.abs(to - from) + columnWidth * 0.6, 10)}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------

export function DiagramView({
  diagram,
  className,
}: {
  diagram: Diagram;
  className?: string;
}) {
  return (
    <figure
      className={cn(
        "overflow-x-auto rounded-lg border border-border bg-card/40 px-3 py-3",
        className,
      )}
    >
      {diagram.title === undefined || diagram.title === "" ? null : (
        <figcaption className="mb-2 text-xs font-medium text-muted-foreground">
          {diagram.title}
        </figcaption>
      )}
      {diagram.kind === "flow" ? (
        <FlowView diagram={diagram} />
      ) : (
        <SequenceView diagram={diagram} />
      )}
    </figure>
  );
}

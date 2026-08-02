import type { ChunkSearchResult } from "../local-vector/search";
import type { WalkNode } from "./types";

export const NODE_WIDTH = 414;
export const NODE_MIN_HEIGHT = 276;
export const COLUMN_GAP = 156;
export const ROW_GAP = 36;

const VERTICAL_STEP = NODE_MIN_HEIGHT + ROW_GAP;

export interface NodePlacement {
  nodeId: string;
  x: number;
  y: number;
}

function isAvailable(y: number, occupiedYs: number[]): boolean {
  return occupiedYs.every((occupiedY) => Math.abs(y - occupiedY) >= VERTICAL_STEP);
}

function nearestAvailableY(targetY: number, occupiedYs: number[]): number {
  if (isAvailable(targetY, occupiedYs)) return targetY;

  const choices = occupiedYs
    .flatMap((occupiedY) => [occupiedY - VERTICAL_STEP, occupiedY + VERTICAL_STEP])
    .filter((candidateY) => isAvailable(candidateY, occupiedYs))
    .sort((left, right) => Math.abs(left - targetY) - Math.abs(right - targetY) || left - right);

  if (choices.length > 0) return choices[0];
  return targetY;
}

export function layoutChildren(
  parent: WalkNode,
  candidates: ChunkSearchResult[],
  existingNodes: Record<string, WalkNode>,
): Array<{ chunkId: string; x: number; y: number }> {
  const childX = parent.x + NODE_WIDTH + COLUMN_GAP;
  const occupiedYs = Object.values(existingNodes)
    .filter((node) => node.x === childX)
    .map((node) => node.y);
  const seen = new Set<string>();
  const newCandidates = candidates.filter((candidate) => {
    if (seen.has(candidate.chunkId) || existingNodes[candidate.chunkId]) return false;
    seen.add(candidate.chunkId);
    return true;
  });
  const placements: Array<{ chunkId: string; x: number; y: number }> = [];

  for (let index = 0; index < newCandidates.length; index++) {
    const candidate = newCandidates[index];
    const targetY = parent.y + (index - (newCandidates.length - 1) / 2) * VERTICAL_STEP;
    const y = nearestAvailableY(targetY, occupiedYs);
    occupiedYs.push(y);
    placements.push({ chunkId: candidate.chunkId, x: childX, y });
  }

  return placements;
}

function restoredCollisionRanges(
  restoredNodes: WalkNode[],
  occupiedNodes: WalkNode[],
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const restoredNode of restoredNodes) {
    for (const occupiedNode of occupiedNodes) {
      if (restoredNode.x !== occupiedNode.x) continue;
      const collisionCenter = occupiedNode.y - restoredNode.y;
      ranges.push({
        start: collisionCenter - VERTICAL_STEP,
        end: collisionCenter + VERTICAL_STEP,
      });
    }
  }
  return ranges.sort((left, right) => left.start - right.start || left.end - right.end);
}

function nearestAvailableRestoredOffset(ranges: Array<{ start: number; end: number }>): number {
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  const blockingRange = merged.find((range) => range.start < 0 && range.end > 0);
  if (!blockingRange) return 0;
  return Math.abs(blockingRange.start) <= Math.abs(blockingRange.end)
    ? blockingRange.start
    : blockingRange.end;
}

export function layoutRestoredNodes(
  restoredNodes: WalkNode[],
  occupiedNodes: WalkNode[],
): NodePlacement[] {
  const automaticNodes = restoredNodes.filter((node) => node.positionMode === "auto");
  if (automaticNodes.length === 0) return [];

  const fixedNodes = [
    ...occupiedNodes,
    ...restoredNodes.filter((node) => node.positionMode === "manual"),
  ];
  const offsetY = nearestAvailableRestoredOffset(restoredCollisionRanges(automaticNodes, fixedNodes));
  if (offsetY === 0) return [];
  return automaticNodes.map((node) => ({ nodeId: node.id, x: node.x, y: node.y + offsetY }));
}

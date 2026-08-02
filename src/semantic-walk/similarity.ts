export type RelationBand = "strong" | "related" | "exploratory";

export interface DistanceResult {
  distance: number;
}

export function labelSimilarityBands<T extends DistanceResult>(results: T[]): Array<T & { relationBand: RelationBand }> {
  const ranked = [...results].sort((left, right) => left.distance - right.distance);
  const total = ranked.length;
  const edgeCount = total > 1 ? Math.max(1, Math.ceil(total * 0.25)) : total;

  return ranked.map((result, index) => ({
    ...result,
    relationBand: index < edgeCount
      ? "strong"
      : index >= total - edgeCount
        ? "exploratory"
        : "related",
  }));
}

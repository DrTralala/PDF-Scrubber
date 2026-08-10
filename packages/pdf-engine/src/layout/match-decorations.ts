import type {
  HalfOpenRange,
  MatchedSourceDecoration,
  PdfColour,
  SourceDecorationGraphic,
  SourceDecorationWarning,
  TextDecorationKind,
} from '../model';

export const DECORATION_MATCH_THRESHOLDS = Object.freeze({
  parallelDegrees: 1,
  minimumRunOverlap: 0.9,
  maximumExtensionEm: 0.15,
  minimumThicknessEm: 0.02,
  maximumThicknessEm: 0.2,
  underlineMinimumEm: -0.35,
  underlineMaximumEm: -0.02,
  strikeMinimumEm: 0.2,
  strikeMaximumEm: 0.65,
  colourTolerance: 0.02,
});

export type DecorationTextOwner = Readonly<{
  lineKey: string;
  glyphRange: HalfOpenRange;
  baseline: readonly [readonly [number, number], readonly [number, number]];
  em: number;
  colour: PdfColour;
}>;

export type DecorationMatchResult = Readonly<{
  decorations: readonly MatchedSourceDecoration[];
  warnings: readonly SourceDecorationWarning[];
}>;

type OwnerEvaluation = Readonly<{
  owner: DecorationTextOwner;
  kind: TextDecorationKind | null;
  parallel: boolean;
  colourCompatible: boolean;
  thicknessCompatible: boolean;
  overlapRatio: number;
  leftExtension: number;
  rightExtension: number;
}>;

function compatibleColour(left: PdfColour, right: PdfColour): boolean {
  return left.colourSpace === right.colourSpace &&
    left.components.length === right.components.length &&
    left.components.every((value, index) =>
      Math.abs(value - right.components[index]!) <=
        DECORATION_MATCH_THRESHOLDS.colourTolerance + Number.EPSILON);
}

function evaluate(
  graphic: SourceDecorationGraphic,
  owner: DecorationTextOwner,
): OwnerEvaluation {
  const [[startX, startY], [endX, endY]] = owner.baseline;
  const ownerLength = Math.hypot(endX - startX, endY - startY);
  const [[graphicStartX, graphicStartY], [graphicEndX, graphicEndY]] = graphic.axis;
  const graphicLength = Math.hypot(
    graphicEndX - graphicStartX,
    graphicEndY - graphicStartY,
  );
  if (!(ownerLength > 0) || !(graphicLength > 0) || !(owner.em > 0)) {
    return Object.freeze({
      owner,
      kind: null,
      parallel: false,
      colourCompatible: false,
      thicknessCompatible: false,
      overlapRatio: 0,
      leftExtension: Number.POSITIVE_INFINITY,
      rightExtension: Number.POSITIVE_INFINITY,
    });
  }
  const direction = Object.freeze([(endX - startX) / ownerLength, (endY - startY) / ownerLength]);
  const graphicDirection = Object.freeze([
    (graphicEndX - graphicStartX) / graphicLength,
    (graphicEndY - graphicStartY) / graphicLength,
  ]);
  const parallel = Math.abs(
    direction[0]! * graphicDirection[0]! + direction[1]! * graphicDirection[1]!,
  ) + Number.EPSILON >= Math.cos(
    DECORATION_MATCH_THRESHOLDS.parallelDegrees * Math.PI / 180,
  );
  const normal = Object.freeze([-direction[1]!, direction[0]!]);
  const centre = Object.freeze([
    (graphicStartX + graphicEndX) / 2,
    (graphicStartY + graphicEndY) / 2,
  ]);
  const offsetEm = (
    (centre[0]! - startX) * normal[0]! + (centre[1]! - startY) * normal[1]!
  ) / owner.em;
  const kind = offsetEm >= DECORATION_MATCH_THRESHOLDS.underlineMinimumEm &&
      offsetEm <= DECORATION_MATCH_THRESHOLDS.underlineMaximumEm
    ? 'underline'
    : offsetEm >= DECORATION_MATCH_THRESHOLDS.strikeMinimumEm &&
        offsetEm <= DECORATION_MATCH_THRESHOLDS.strikeMaximumEm
      ? 'strikethrough'
      : null;
  const project = (x: number, y: number): number =>
    (x - startX) * direction[0]! + (y - startY) * direction[1]!;
  const projected = [
    project(graphicStartX, graphicStartY),
    project(graphicEndX, graphicEndY),
  ].sort((left, right) => left - right);
  const candidateStart = projected[0]!;
  const candidateEnd = projected[1]!;
  const overlap = Math.max(0, Math.min(ownerLength, candidateEnd) - Math.max(0, candidateStart));
  const thicknessEm = graphic.thickness / owner.em;
  return Object.freeze({
    owner,
    kind,
    parallel,
    colourCompatible: compatibleColour(graphic.colour, owner.colour),
    thicknessCompatible:
      thicknessEm + Number.EPSILON >= DECORATION_MATCH_THRESHOLDS.minimumThicknessEm &&
      thicknessEm <= DECORATION_MATCH_THRESHOLDS.maximumThicknessEm + Number.EPSILON,
    overlapRatio: overlap / ownerLength,
    leftExtension: Math.max(0, -candidateStart) / owner.em,
    rightExtension: Math.max(0, candidateEnd - ownerLength) / owner.em,
  });
}

function plausible(value: OwnerEvaluation): boolean {
  return value.parallel && value.kind !== null && value.thicknessCompatible &&
    value.overlapRatio > 0.1;
}

function exact(value: OwnerEvaluation): boolean {
  return plausible(value) && value.colourCompatible &&
    value.overlapRatio + Number.EPSILON >= DECORATION_MATCH_THRESHOLDS.minimumRunOverlap &&
    value.leftExtension <= DECORATION_MATCH_THRESHOLDS.maximumExtensionEm + Number.EPSILON &&
    value.rightExtension <= DECORATION_MATCH_THRESHOLDS.maximumExtensionEm + Number.EPSILON;
}

function warning(
  graphic: SourceDecorationGraphic,
  reason: SourceDecorationWarning['reason'],
  owners: readonly DecorationTextOwner[],
): SourceDecorationWarning {
  const lineKeys = [...new Set(owners.map(({ lineKey }) => lineKey))];
  return Object.freeze({
    reason,
    graphic,
    lineKey: lineKeys.length === 1 ? lineKeys[0]! : null,
    glyphRanges: Object.freeze(owners.map(({ glyphRange }) => glyphRange)),
  });
}

export function matchDecorationGraphics(
  graphics: readonly SourceDecorationGraphic[],
  owners: readonly DecorationTextOwner[],
): DecorationMatchResult {
  const decorations: MatchedSourceDecoration[] = [];
  const warnings: SourceDecorationWarning[] = [];

  for (const graphic of graphics) {
    const evaluations = owners.map((owner) => evaluate(graphic, owner));
    const plausibleOwners = evaluations.filter(plausible).map(({ owner }) => owner);
    const exactMatches = evaluations.filter(exact);
    if (graphic.referenceCount !== 1) {
      warnings.push(warning(graphic, 'shared-content', plausibleOwners));
      continue;
    }
    if (exactMatches.length === 1 && plausibleOwners.length === 1) {
      const match = exactMatches[0]!;
      decorations.push(Object.freeze({
        kind: match.kind!,
        graphic,
        lineKey: match.owner.lineKey,
        glyphRange: match.owner.glyphRange,
      }));
      continue;
    }
    warnings.push(warning(
      graphic,
      plausibleOwners.length > 1 ? 'multiple-owners' : 'ambiguous-geometry',
      plausibleOwners,
    ));
  }
  return Object.freeze({
    decorations: Object.freeze(decorations),
    warnings: Object.freeze(warnings),
  });
}

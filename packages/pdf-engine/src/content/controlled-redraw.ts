import type { ContentOperation, PdfOperand } from './tokeniser';
import { isSupportedMarkedContentTag } from './brand-markers';
import type { TextDecorations } from '../model';

export type ControlledRedraw = Readonly<{
  version: 1 | 2 | 3;
  actualText: string;
  commandHash: string | null;
  fontResourceNames: readonly string[];
  textOperationIndexes: readonly number[];
  textFontResourceNames: readonly string[];
  runGlyphCounts: readonly number[] | null;
  runDecorations: readonly TextDecorations[] | null;
  textRunIndexes: readonly number[] | null;
  decorationOperationIndexes: readonly number[];
}>;

function actualText(operand: PdfOperand): string | null {
  if (operand.kind !== 'hexString') return null;
  const bytes = operand.value;
  if (bytes.length < 2 || bytes.length % 2 !== 0 || bytes[0] !== 0xfe || bytes[1] !== 0xff) {
    return null;
  }
  let text = '';
  for (let index = 2; index < bytes.length; index += 2) {
    text += String.fromCharCode((bytes[index]! << 8) | bytes[index + 1]!);
  }
  return text;
}

function noOperands(operation: ContentOperation, operator: string): boolean {
  return operation.operator === operator && operation.operands.length === 0;
}

function nonEmptyHexString(operand: PdfOperand | undefined): boolean {
  return operand?.kind === 'hexString' && operand.value.byteLength > 0;
}

function dictionaryValue(
  operand: PdfOperand,
  name: string,
): PdfOperand | null {
  if (operand.kind !== 'dictionary') return null;
  const matches = operand.entries.filter(([key]) => key.value === name);
  return matches.length === 1 ? matches[0]![1] : null;
}

function controlledFontName(operand: PdfOperand | undefined, version: 1 | 2 | 3): string | null {
  if (operand?.kind !== 'name') return null;
  const expression = version === 1
    ? /^M0R_[0-9a-f]{16}$/
    : /^M0R_[0-9a-f]{16}_[0-9]+$/;
  return expression.test(operand.value) ? operand.value : null;
}

function parseV1(operations: readonly ContentOperation[]): ControlledRedraw | null {
  if (operations.length < 9) return null;
  if (
    !noOperands(operations[0]!, 'q') ||
    !noOperands(operations[1]!, 'BT') ||
    !noOperands(operations.at(-3)!, 'EMC') ||
    !noOperands(operations.at(-2)!, 'ET') ||
    !noOperands(operations.at(-1)!, 'Q')
  ) return null;

  const font = operations[2]!;
  const fontName = controlledFontName(font.operands[0], 1);
  const fontSize = font.operands[1];
  if (
    font.operator !== 'Tf' ||
    font.operands.length !== 2 ||
    fontName === null ||
    fontSize?.kind !== 'number' ||
    !(fontSize.value > 0)
  ) return null;

  const marked = operations[3]!;
  const tag = marked.operands[0];
  const properties = marked.operands[1];
  if (
    marked.operator !== 'BDC' ||
    marked.operands.length !== 2 ||
    tag?.kind !== 'name' ||
    tag.value !== 'Span' ||
    properties?.kind !== 'dictionary' ||
    properties.entries.length !== 1
  ) return null;
  const [entry] = properties.entries;
  if (entry === undefined || entry[0].value !== 'ActualText') return null;
  const text = actualText(entry[1]);
  if (text === null || text.length === 0) return null;

  const textOperationIndexes: number[] = [];
  for (let index = 4; index < operations.length - 3; index += 2) {
    const matrix = operations[index];
    const showing = operations[index + 1];
    if (
      matrix?.operator !== 'Tm' ||
      matrix.operands.length !== 6 ||
      matrix.operands.some((operand) => operand.kind !== 'number' || !Number.isFinite(operand.value)) ||
      showing?.operator !== 'Tj' ||
      showing.operands.length !== 1 ||
      !nonEmptyHexString(showing.operands[0])
    ) return null;
    textOperationIndexes.push(index + 1);
  }
  if (textOperationIndexes.length === 0 || operations.length !== 7 + textOperationIndexes.length * 2) {
    return null;
  }
  return Object.freeze({
    version: 1,
    actualText: text,
    commandHash: null,
    fontResourceNames: Object.freeze([fontName]),
    textOperationIndexes: Object.freeze(textOperationIndexes),
    textFontResourceNames: Object.freeze(textOperationIndexes.map(() => fontName)),
    runGlyphCounts: null,
    runDecorations: null,
    textRunIndexes: null,
    decorationOperationIndexes: Object.freeze([]),
  });
}

const V2_STATE_OPERATORS = new Set([
  'Tf', 'Tc', 'Tw', 'Tz', 'Ts', 'Tr', 'g', 'G', 'rg', 'RG', 'k', 'K', 'Tm', 'Tj',
]);

function parseV2(operations: readonly ContentOperation[]): ControlledRedraw | null {
  if (operations.length < 8) return null;
  if (
    !noOperands(operations[0]!, 'q') ||
    !noOperands(operations[2]!, 'BT') ||
    !noOperands(operations.at(-3)!, 'ET') ||
    !noOperands(operations.at(-2)!, 'EMC') ||
    !noOperands(operations.at(-1)!, 'Q')
  ) return null;

  const marked = operations[1]!;
  const tag = marked.operands[0];
  const properties = marked.operands[1];
  if (
    marked.operator !== 'BDC' ||
    marked.operands.length !== 2 ||
    tag?.kind !== 'name' ||
     !isSupportedMarkedContentTag(tag.value) ||
    properties?.kind !== 'dictionary' ||
    properties.entries.length !== 3
  ) return null;
  const version = dictionaryValue(properties, 'Version');
  const actual = dictionaryValue(properties, 'ActualText');
  const hash = dictionaryValue(properties, 'CommandHash');
  const text = actual === null ? null : actualText(actual);
  if (
    version?.kind !== 'number' || version.value !== 2 ||
    text === null || text.length === 0 ||
    hash?.kind !== 'hexString' || hash.value.byteLength !== 32
  ) return null;
  const commandHash = [...hash.value]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  const fontResourceNames: string[] = [];
  const textOperationIndexes: number[] = [];
  const textFontResourceNames: string[] = [];
  let currentFont: string | null = null;
  for (let index = 3; index < operations.length - 3; index += 1) {
    const operation = operations[index]!;
    if (!V2_STATE_OPERATORS.has(operation.operator)) return null;
    if (operation.operator === 'Tf') {
      const fontName = controlledFontName(operation.operands[0], 2);
      const size = operation.operands[1];
      if (
        operation.operands.length !== 2 || fontName === null ||
        size?.kind !== 'number' || !(size.value > 0)
      ) return null;
      currentFont = fontName;
      if (!fontResourceNames.includes(fontName)) fontResourceNames.push(fontName);
    }
    if (operation.operator === 'Tm' && (
      operation.operands.length !== 6 ||
      operation.operands.some((operand) => operand.kind !== 'number' || !Number.isFinite(operand.value))
    )) return null;
    if (operation.operator === 'Tj') {
      if (
        currentFont === null ||
        operation.operands.length !== 1 ||
        !nonEmptyHexString(operation.operands[0]) ||
        operations[index - 1]?.operator !== 'Tm'
      ) return null;
      textOperationIndexes.push(index);
      textFontResourceNames.push(currentFont);
    }
  }
  if (textOperationIndexes.length === 0) return null;
  return Object.freeze({
    version: 2,
    actualText: text,
    commandHash,
    fontResourceNames: Object.freeze(fontResourceNames),
    textOperationIndexes: Object.freeze(textOperationIndexes),
    textFontResourceNames: Object.freeze(textFontResourceNames),
    runGlyphCounts: null,
    runDecorations: null,
    textRunIndexes: null,
    decorationOperationIndexes: Object.freeze([]),
  });
}

function integerArray(operand: PdfOperand | null, minimum: number, maximum: number): number[] | null {
  if (operand?.kind !== 'array' || operand.items.length === 0) return null;
  const values: number[] = [];
  for (const item of operand.items) {
    if (
      item.kind !== 'number' || !Number.isSafeInteger(item.value) ||
      item.value < minimum || item.value > maximum
    ) return null;
    values.push(item.value);
  }
  return values;
}

function parseRichTextOperations(
  operations: readonly ContentOperation[],
  start: number,
  end: number,
  version: 2 | 3,
): Readonly<{
  fontResourceNames: readonly string[];
  textOperationIndexes: readonly number[];
  textFontResourceNames: readonly string[];
}> | null {
  const fontResourceNames: string[] = [];
  const textOperationIndexes: number[] = [];
  const textFontResourceNames: string[] = [];
  let currentFont: string | null = null;
  for (let index = start; index < end; index += 1) {
    const operation = operations[index]!;
    if (!V2_STATE_OPERATORS.has(operation.operator)) return null;
    if (operation.operator === 'Tf') {
      const fontName = controlledFontName(operation.operands[0], version);
      const size = operation.operands[1];
      if (
        operation.operands.length !== 2 || fontName === null ||
        size?.kind !== 'number' || !(size.value > 0)
      ) return null;
      currentFont = fontName;
      if (!fontResourceNames.includes(fontName)) fontResourceNames.push(fontName);
    }
    if (operation.operator === 'Tm' && (
      operation.operands.length !== 6 ||
      operation.operands.some((operand) => operand.kind !== 'number' || !Number.isFinite(operand.value))
    )) return null;
    if (operation.operator === 'Tj') {
      if (
        currentFont === null ||
        operation.operands.length !== 1 ||
        !nonEmptyHexString(operation.operands[0]) ||
        operations[index - 1]?.operator !== 'Tm'
      ) return null;
      textOperationIndexes.push(index);
      textFontResourceNames.push(currentFont);
    }
  }
  return textOperationIndexes.length === 0 ? null : Object.freeze({
    fontResourceNames: Object.freeze(fontResourceNames),
    textOperationIndexes: Object.freeze(textOperationIndexes),
    textFontResourceNames: Object.freeze(textFontResourceNames),
  });
}

function finiteCoordinates(operation: ContentOperation, count: number): boolean {
  return operation.operands.length === count && operation.operands.every((operand) =>
    operand.kind === 'number' && Number.isFinite(operand.value));
}

function fillColour(operation: ContentOperation): boolean {
  const count = operation.operator === 'g' ? 1 : operation.operator === 'rg' ? 3 :
    operation.operator === 'k' ? 4 : 0;
  return count > 0 && finiteCoordinates(operation, count);
}

function decorationPaths(
  operations: readonly ContentOperation[],
  start: number,
  end: number,
  expectedCount: number,
): readonly number[] | null {
  if (expectedCount === 0) return start === end ? Object.freeze([]) : null;
  const indexes: number[] = [];
  let cursor = start;
  while (cursor < end) {
    const colour = operations[cursor];
    const move = operations[cursor + 1];
    const first = operations[cursor + 2];
    const second = operations[cursor + 3];
    const third = operations[cursor + 4];
    const close = operations[cursor + 5];
    const fill = operations[cursor + 6];
    if (
      colour === undefined || !fillColour(colour) ||
      move?.operator !== 'm' || !finiteCoordinates(move, 2) ||
      first?.operator !== 'l' || !finiteCoordinates(first, 2) ||
      second?.operator !== 'l' || !finiteCoordinates(second, 2) ||
      third?.operator !== 'l' || !finiteCoordinates(third, 2) ||
      close === undefined || !noOperands(close, 'h') ||
      fill === undefined || !noOperands(fill, 'f')
    ) return null;
    indexes.push(cursor + 6);
    cursor += 7;
  }
  return cursor === end && indexes.length === expectedCount
    ? Object.freeze(indexes)
    : null;
}

function parseV3(operations: readonly ContentOperation[]): ControlledRedraw | null {
  if (
    operations.length < 9 ||
    !noOperands(operations[0]!, 'q') ||
    !noOperands(operations[2]!, 'BT') ||
    !noOperands(operations.at(-2)!, 'EMC') ||
    !noOperands(operations.at(-1)!, 'Q')
  ) return null;
  const marked = operations[1]!;
  const tag = marked.operands[0];
  const properties = marked.operands[1];
  if (
    marked.operator !== 'BDC' || marked.operands.length !== 2 ||
     tag?.kind !== 'name' || !isSupportedMarkedContentTag(tag.value) ||
    properties?.kind !== 'dictionary' || properties.entries.length !== 5
  ) return null;
  const version = dictionaryValue(properties, 'Version');
  const actual = dictionaryValue(properties, 'ActualText');
  const hash = dictionaryValue(properties, 'CommandHash');
  const counts = integerArray(dictionaryValue(properties, 'RunGlyphCounts'), 1, 1_000_000);
  const flags = integerArray(dictionaryValue(properties, 'RunDecorations'), 0, 3);
  const text = actual === null ? null : actualText(actual);
  if (
    version?.kind !== 'number' || version.value !== 3 ||
    text === null || text.length === 0 ||
    hash?.kind !== 'hexString' || hash.value.byteLength !== 32 ||
    counts === null || flags === null || counts.length !== flags.length
  ) return null;
  const textEnd = operations.findIndex((operation, index) => index >= 3 && noOperands(operation, 'ET'));
  if (textEnd < 4) return null;
  const richText = parseRichTextOperations(operations, 3, textEnd, 3);
  if (richText === null || counts.reduce((total, count) => total + count, 0)
    !== richText.textOperationIndexes.length) return null;
  const expectedDecorations = flags.reduce(
    (total, flag) => total + Number((flag & 1) !== 0) + Number((flag & 2) !== 0),
    0,
  );
  const decorationOperationIndexes = decorationPaths(
    operations,
    textEnd + 1,
    operations.length - 2,
    expectedDecorations,
  );
  if (decorationOperationIndexes === null) return null;
  const runDecorations = Object.freeze(flags.map((flag): TextDecorations => Object.freeze({
    underline: (flag & 1) !== 0,
    strikethrough: (flag & 2) !== 0,
  })));
  const textRunIndexes = Object.freeze(counts.flatMap((count, runIndex) =>
    Array.from({ length: count }, () => runIndex)));
  return Object.freeze({
    version: 3,
    actualText: text,
    commandHash: [...hash.value].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    ...richText,
    runGlyphCounts: Object.freeze(counts),
    runDecorations,
    textRunIndexes,
    decorationOperationIndexes,
  });
}

export function parseControlledRedraw(
  operations: readonly ContentOperation[],
): ControlledRedraw | null {
  return parseV3(operations) ?? parseV2(operations) ?? parseV1(operations);
}

import type {
  EffectiveTextStyle,
  HalfOpenRange,
  RichFontIntent,
  TextDecorations,
} from '@pdf-editor/pdf-engine';

export type EditorRichTextRun = Readonly<{
  text: string;
  style: EffectiveTextStyle;
  fontId: string;
  fontIntent: RichFontIntent;
  decorations: TextDecorations;
  sourceRunIndex?: number | null;
}>;

export type RichTextFormatPatch = Readonly<{
  style?: Partial<EffectiveTextStyle>;
  fontId?: string;
  fontIntent?: RichFontIntent;
  decorations?: Partial<TextDecorations>;
}>;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function ownedRun(run: EditorRichTextRun): EditorRichTextRun {
  return Object.freeze({
    text: run.text,
    style: Object.freeze({ ...run.style }),
    fontId: run.fontId,
    fontIntent: run.fontIntent,
    decorations: Object.freeze({ ...run.decorations }),
    sourceRunIndex: run.sourceRunIndex ?? null,
  });
}

function samePresentation(left: EditorRichTextRun, right: EditorRichTextRun): boolean {
  return (left.sourceRunIndex ?? null) === (right.sourceRunIndex ?? null) &&
    left.fontId === right.fontId &&
    left.fontIntent === right.fontIntent &&
    left.decorations.underline === right.decorations.underline &&
    left.decorations.strikethrough === right.decorations.strikethrough &&
    JSON.stringify(left.style) === JSON.stringify(right.style);
}

function mergeRuns(runs: readonly EditorRichTextRun[]): readonly EditorRichTextRun[] {
  const merged: EditorRichTextRun[] = [];
  for (const source of runs) {
    const run = ownedRun(source);
    const previous = merged.at(-1);
    if (previous !== undefined && samePresentation(previous, run)) {
      merged[merged.length - 1] = ownedRun({ ...previous, text: previous.text + run.text });
    } else {
      merged.push(run);
    }
  }
  return Object.freeze(merged);
}

function graphemeRange(text: string, input: HalfOpenRange): HalfOpenRange {
  const start = Math.max(0, Math.min(text.length, Math.trunc(input.start)));
  const end = Math.max(start, Math.min(text.length, Math.trunc(input.end)));
  if (start === end) return Object.freeze({ start, end });
  const segments = [...segmenter.segment(text)];
  const first = segments.find(({ index, segment }) => start >= index && start < index + segment.length);
  const last = segments.find(({ index, segment }) => end > index && end <= index + segment.length);
  return Object.freeze({
    start: first?.index ?? start,
    end: last === undefined ? end : last.index + last.segment.length,
  });
}

function sliceRuns(
  runs: readonly EditorRichTextRun[],
  start: number,
  end: number,
): EditorRichTextRun[] {
  const sliced: EditorRichTextRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const runStart = offset;
    const runEnd = offset + run.text.length;
    const localStart = Math.max(0, start - runStart);
    const localEnd = Math.min(run.text.length, end - runStart);
    if (localStart < localEnd) {
      sliced.push(ownedRun({ ...run, text: run.text.slice(localStart, localEnd) }));
    }
    offset = runEnd;
  }
  return sliced;
}

function runAt(runs: readonly EditorRichTextRun[], index: number): EditorRichTextRun {
  let offset = 0;
  for (const run of runs) {
    if (index >= offset && index < offset + run.text.length) return run;
    offset += run.text.length;
  }
  const fallback = runs.at(-1);
  if (fallback === undefined) throw new RangeError('Rich text buffer requires a style run');
  return fallback;
}

export class RichTextBuffer {
  readonly runs: readonly EditorRichTextRun[];
  readonly text: string;

  private constructor(runs: readonly EditorRichTextRun[]) {
    if (runs.length === 0) throw new RangeError('Rich text buffer requires at least one run');
    this.runs = mergeRuns(runs);
    this.text = this.runs.map(({ text }) => text).join('');
    Object.freeze(this);
  }

  static fromRuns(runs: readonly EditorRichTextRun[]): RichTextBuffer {
    return new RichTextBuffer(runs);
  }

  replace(inputRange: HalfOpenRange, insertedText: string): RichTextBuffer {
    const range = graphemeRange(this.text, inputRange);
    const templateIndex = range.start === range.end && range.start > 0
      ? range.start - 1
      : range.start;
    const template = runAt(this.runs, templateIndex);
    const next = [
      ...sliceRuns(this.runs, 0, range.start),
      ...(insertedText.length === 0 ? [] : [ownedRun({ ...template, text: insertedText })]),
      ...sliceRuns(this.runs, range.end, this.text.length),
    ];
    return new RichTextBuffer(next.length === 0 ? [{ ...template, text: '' }] : next);
  }

  format(inputRange: HalfOpenRange, patch: RichTextFormatPatch): RichTextBuffer {
    const range = graphemeRange(this.text, inputRange);
    if (range.start === range.end) return this;
    const before = sliceRuns(this.runs, 0, range.start);
    const selected = sliceRuns(this.runs, range.start, range.end).map((run) => ownedRun({
      ...run,
      style: Object.freeze({ ...run.style, ...patch.style }),
      fontId: patch.fontId ?? run.fontId,
      fontIntent: patch.fontIntent ?? run.fontIntent,
      decorations: Object.freeze({ ...run.decorations, ...patch.decorations }),
    }));
    const after = sliceRuns(this.runs, range.end, this.text.length);
    return new RichTextBuffer([...before, ...selected, ...after]);
  }
}

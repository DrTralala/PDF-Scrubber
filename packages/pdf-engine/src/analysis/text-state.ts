import type { ContentOperation, PdfOperand } from '../content/tokeniser';
import type { EngineErrorDescriptor } from '../errors';
import { IDENTITY, multiply, type Matrix } from '../geometry/matrix';

export type TextState = Readonly<{
  inTextObject: boolean;
  fontResourceName: string | null;
  fontSize: number;
  characterSpacing: number;
  wordSpacing: number;
  horizontalScaling: number;
  leading: number;
  rise: number;
  renderingMode: number;
  textMatrix: Matrix;
  lineMatrix: Matrix;
}>;

class TextStateError extends Error implements EngineErrorDescriptor {
  readonly code = 'UNSUPPORTED_DOCUMENT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TextStateError';
  }
}

const immutableMatrix = (values: Matrix): Matrix => Object.freeze([...values]) as Matrix;

export function createTextState(): TextState {
  return Object.freeze({
    inTextObject: false,
    fontResourceName: null,
    fontSize: 0,
    characterSpacing: 0,
    wordSpacing: 0,
    horizontalScaling: 1,
    leading: 0,
    rise: 0,
    renderingMode: 0,
    textMatrix: IDENTITY,
    lineMatrix: IDENTITY,
  });
}

function numberOperand(operands: readonly PdfOperand[], index: number, operator: string): number {
  const operand = operands[index];
  if (operand?.kind !== 'number' || !Number.isFinite(operand.value)) {
    throw new TextStateError(`${operator} requires a finite numeric operand`);
  }
  return operand.value;
}

function nameOperand(operands: readonly PdfOperand[], index: number, operator: string): string {
  const operand = operands[index];
  if (operand?.kind !== 'name') {
    throw new TextStateError(`${operator} requires a name operand`);
  }
  return operand.value;
}

function requireCount(operation: ContentOperation, count: number): void {
  if (operation.operands.length !== count) {
    throw new TextStateError(`${operation.operator} requires ${count} operands`);
  }
}

function requireTextObject(state: TextState, operator: string): void {
  if (!state.inTextObject) {
    throw new TextStateError(`${operator} is not valid outside a text object`);
  }
}

function lineMove(state: TextState, x: number, y: number): TextState {
  const lineMatrix = multiply(state.lineMatrix, [1, 0, 0, 1, x, y]);
  return Object.freeze({ ...state, lineMatrix, textMatrix: lineMatrix });
}

export function advanceTextMatrix(state: TextState, amount: number): TextState {
  if (!Number.isFinite(amount)) throw new TextStateError('text advance is not finite');
  return Object.freeze({
    ...state,
    textMatrix: multiply(state.textMatrix, [1, 0, 0, 1, amount, 0]),
  });
}

export function applyTextStateOperation(
  state: TextState,
  operation: ContentOperation,
): TextState {
  const { operator, operands } = operation;
  switch (operator) {
    case 'BT':
      requireCount(operation, 0);
      return Object.freeze({
        ...state,
        inTextObject: true,
        textMatrix: IDENTITY,
        lineMatrix: IDENTITY,
      });
    case 'ET':
      requireTextObject(state, operator);
      requireCount(operation, 0);
      return Object.freeze({ ...state, inTextObject: false });
    case 'Tf':
      requireTextObject(state, operator);
      requireCount(operation, 2);
      return Object.freeze({
        ...state,
        fontResourceName: nameOperand(operands, 0, operator),
        fontSize: numberOperand(operands, 1, operator),
      });
    case 'Tm': {
      requireTextObject(state, operator);
      requireCount(operation, 6);
      const matrix = immutableMatrix(
        operands.map((_operand, index) => numberOperand(operands, index, operator)) as unknown as Matrix,
      );
      return Object.freeze({ ...state, textMatrix: matrix, lineMatrix: matrix });
    }
    case 'Td':
      requireTextObject(state, operator);
      requireCount(operation, 2);
      return lineMove(
        state,
        numberOperand(operands, 0, operator),
        numberOperand(operands, 1, operator),
      );
    case 'TD': {
      requireTextObject(state, operator);
      requireCount(operation, 2);
      const x = numberOperand(operands, 0, operator);
      const y = numberOperand(operands, 1, operator);
      return lineMove(Object.freeze({ ...state, leading: -y }), x, y);
    }
    case 'T*':
      requireTextObject(state, operator);
      requireCount(operation, 0);
      return lineMove(state, 0, -state.leading);
    case 'Tc':
      requireTextObject(state, operator);
      requireCount(operation, 1);
      return Object.freeze({
        ...state,
        characterSpacing: numberOperand(operands, 0, operator),
      });
    case 'Tw':
      requireTextObject(state, operator);
      requireCount(operation, 1);
      return Object.freeze({ ...state, wordSpacing: numberOperand(operands, 0, operator) });
    case 'Tz':
      requireTextObject(state, operator);
      requireCount(operation, 1);
      return Object.freeze({
        ...state,
        horizontalScaling: numberOperand(operands, 0, operator) / 100,
      });
    case 'TL':
      requireTextObject(state, operator);
      requireCount(operation, 1);
      return Object.freeze({ ...state, leading: numberOperand(operands, 0, operator) });
    case 'Ts':
      requireTextObject(state, operator);
      requireCount(operation, 1);
      return Object.freeze({ ...state, rise: numberOperand(operands, 0, operator) });
    case 'Tr': {
      requireTextObject(state, operator);
      requireCount(operation, 1);
      const renderingMode = numberOperand(operands, 0, operator);
      if (!Number.isSafeInteger(renderingMode) || renderingMode < 0 || renderingMode > 7) {
        throw new TextStateError('Tr requires an integer from zero through seven');
      }
      return Object.freeze({ ...state, renderingMode });
    }
    case "'":
      requireTextObject(state, operator);
      requireCount(operation, 1);
      return lineMove(state, 0, -state.leading);
    case '"': {
      requireTextObject(state, operator);
      requireCount(operation, 3);
      const moved = lineMove(state, 0, -state.leading);
      return Object.freeze({
        ...moved,
        wordSpacing: numberOperand(operands, 0, operator),
        characterSpacing: numberOperand(operands, 1, operator),
      });
    }
    default:
      return state;
  }
}

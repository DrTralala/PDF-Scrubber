import type { EngineRequest, EngineResponse } from './messages';

export function transferListForRequest(request: EngineRequest): Transferable[] {
  return request.operation === 'openDocument' || request.operation === 'registerFont'
    ? [request.payload.bytes]
    : [];
}

export function transferListForResponse(
  response: EngineResponse,
): Transferable[] {
  return response.ok && response.operation === 'exportDocument'
    ? [response.value.bytes]
    : [];
}

export interface CursorPoint {
  x: number
  y: number
}

export interface MonitorBounds extends CursorPoint {
  width: number
  height: number
}

export interface ForcedMouseState {
  point: CursorPoint
  bounds: MonitorBounds
}

export function createForcedMouseState(point: CursorPoint, bounds: MonitorBounds): ForcedMouseState {
  return { point: clampPoint(point, bounds), bounds }
}

export function applyMouseDelta(state: ForcedMouseState, delta: CursorPoint, speed: number): CursorPoint {
  state.point = clampPoint({
    x: state.point.x + delta.x * speed,
    y: state.point.y + delta.y * speed,
  }, state.bounds)

  return state.point
}

export function reinitializeForcedMouseState(state: ForcedMouseState, point: CursorPoint, bounds: MonitorBounds): void {
  state.bounds = bounds
  state.point = clampPoint(point, bounds)
}

function clampPoint(point: CursorPoint, bounds: MonitorBounds): CursorPoint {
  return {
    x: Math.min(Math.max(point.x, bounds.x), bounds.x + bounds.width),
    y: Math.min(Math.max(point.y, bounds.y), bounds.y + bounds.height),
  }
}

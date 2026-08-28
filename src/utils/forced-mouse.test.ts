import assert from 'node:assert/strict'
import test from 'node:test'

import { applyMouseDelta, createForcedMouseState, reinitializeForcedMouseState } from './forced-mouse'

const bounds = { x: 100, y: 50, width: 400, height: 300 }

test('initializes from the real cursor and applies the configured speed', () => {
  const state = createForcedMouseState({ x: 250, y: 150 }, bounds)

  assert.deepEqual(applyMouseDelta(state, { x: 10, y: -5 }, 1.5), { x: 265, y: 142.5 })
})

test('clamps relative movement to the active monitor bounds', () => {
  const state = createForcedMouseState({ x: 495, y: 55 }, bounds)

  assert.deepEqual(applyMouseDelta(state, { x: 100, y: -100 }, 1), { x: 500, y: 50 })
})

test('keeps a zero delta stationary at the boundary', () => {
  const state = createForcedMouseState({ x: 100, y: 350 }, bounds)

  assert.deepEqual(applyMouseDelta(state, { x: 0, y: 0 }, 4), { x: 100, y: 350 })
})

test('reinitializes the virtual cursor when an absolute event enters another monitor', () => {
  const state = createForcedMouseState({ x: 250, y: 150 }, bounds)
  const nextBounds = { x: -800, y: 0, width: 800, height: 600 }

  reinitializeForcedMouseState(state, { x: -25, y: 400 }, nextBounds)

  assert.deepEqual(state, { point: { x: -25, y: 400 }, bounds: nextBounds })
})

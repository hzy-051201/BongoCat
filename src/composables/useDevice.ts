import type { Monitor } from '@tauri-apps/api/window'

import { invoke } from '@tauri-apps/api/core'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { cursorPosition } from '@tauri-apps/api/window'
import { isNil } from 'es-toolkit'
import { Ticker } from 'pixi.js'
import { onMounted, onUnmounted, ref, watch } from 'vue'

import type { ForcedMouseState } from '@/utils/forced-mouse'

import { useAppStore } from '@/stores/app'
import { useCatStore } from '@/stores/cat'
import { useModelStore } from '@/stores/model'
import { applyMouseDelta, createForcedMouseState, reinitializeForcedMouseState } from '@/utils/forced-mouse'
import { inBetween } from '@/utils/is'
import { getCursorMonitor } from '@/utils/monitor'
import { isMac, isWindows } from '@/utils/platform'

import { INVOKE_KEY, LISTEN_KEY, WINDOW_LABEL } from '../constants'
import { useModel } from './useModel'
import { useTauriListen } from './useTauriListen'

interface MouseButtonEvent {
  kind: 'MousePress' | 'MouseRelease'
  value: string
}

export interface CursorPoint {
  x: number
  y: number
}

interface MouseMoveEvent {
  kind: 'MouseMove'
  value: CursorPoint
}

interface MouseDeltaEvent {
  kind: 'MouseDelta'
  value: CursorPoint
}

interface KeyboardEvent {
  kind: 'KeyboardPress' | 'KeyboardRelease'
  value: string
}

type DeviceEvent = MouseButtonEvent | MouseMoveEvent | MouseDeltaEvent | KeyboardEvent

const DAMPING_DECAY = 0.75
const appWindow = getCurrentWebviewWindow()

export function useDevice() {
  const modelStore = useModelStore()
  const releaseTimers = new Map<string, NodeJS.Timeout>()
  const appStore = useAppStore()
  const catStore = useCatStore()
  const latestCursorPoint = ref<CursorPoint>()
  const smoothedCursorPoint = ref<CursorPoint>()
  const forcedMouseState = ref<ForcedMouseState>()
  const pendingMouseDelta = ref<CursorPoint>({ x: 0, y: 0 })
  const scaleFactor = ref(1)
  const { handlePress, handleRelease, handleMouseChange, handleMouseMove } = useModel()

  const toMonitorBounds = (monitor: Monitor) => ({
    x: monitor.position.x,
    y: monitor.position.y,
    width: monitor.size.width,
    height: monitor.size.height,
  })

  let forcedMouseInitPromise: Promise<boolean> | undefined

  const initForcedMouseState = () => {
    forcedMouseInitPromise ??= (async () => {
      try {
        if (!catStore.model.forceMouseMove) return false

        const point = await cursorPosition()

        if (!catStore.model.forceMouseMove) return false

        const monitor = await getCursorMonitor(point)

        if (!catStore.model.forceMouseMove || !monitor) return false

        forcedMouseState.value = createForcedMouseState(
          { x: point.x, y: point.y },
          toMonitorBounds(monitor),
        )

        return true
      } finally {
        forcedMouseInitPromise = undefined
      }
    })()

    return forcedMouseInitPromise
  }

  const handleMouseDelta = (delta: CursorPoint) => {
    if (!catStore.model.forceMouseMove) return

    if (!forcedMouseState.value) {
      pendingMouseDelta.value = {
        x: pendingMouseDelta.value.x + delta.x,
        y: pendingMouseDelta.value.y + delta.y,
      }

      return void initForcedMouseState().then((ready) => {
        if (!ready || !forcedMouseState.value || !catStore.model.forceMouseMove) return

        latestCursorPoint.value = applyMouseDelta(
          forcedMouseState.value,
          pendingMouseDelta.value,
          catStore.model.mouseSpeed,
        )

        pendingMouseDelta.value = { x: 0, y: 0 }
      })
    }

    latestCursorPoint.value = applyMouseDelta(forcedMouseState.value, delta, catStore.model.mouseSpeed)
  }

  const switchMonitorForAbsoluteCursor = async (point: CursorPoint) => {
    const state = forcedMouseState.value

    if (!state) return

    const monitor = await getCursorMonitor(new PhysicalPosition(point.x, point.y))

    if (!monitor) return

    const bounds = toMonitorBounds(monitor)
    const { bounds: current } = state

    if (
      bounds.x === current.x
      && bounds.y === current.y
      && bounds.width === current.width
      && bounds.height === current.height
    ) {
      return
    }

    reinitializeForcedMouseState(state, point, bounds)

    latestCursorPoint.value = state.point
  }

  const tickerCallback = (ticker: Ticker) => {
    const destination = latestCursorPoint.value

    if (!destination) return

    const current = smoothedCursorPoint.value ?? destination

    const alpha = 1 - DAMPING_DECAY ** (ticker.deltaMS / (1000 / 60))

    const interpolated = {
      x: current.x + (destination.x - current.x) * alpha,
      y: current.y + (destination.y - current.y) * alpha,
    }

    if (Math.hypot(destination.x - interpolated.x, destination.y - interpolated.y) < 0.5) {
      smoothedCursorPoint.value = { ...destination }

      latestCursorPoint.value = void 0
    } else {
      smoothedCursorPoint.value = interpolated
    }

    void handleCursorMove(smoothedCursorPoint.value)
  }

  onMounted(async () => {
    scaleFactor.value = isMac ? await appWindow.scaleFactor() : 1

    appWindow.onScaleChanged(({ payload }) => {
      if (!isMac) return

      scaleFactor.value = payload.scaleFactor
    })
  })

  onUnmounted(() => {
    Ticker.shared.remove(tickerCallback)
  })

  watch(() => catStore.model.ignoreMouse, (value) => {
    if (value) {
      return Ticker.shared.remove(tickerCallback)
    }

    return Ticker.shared.add(tickerCallback)
  }, { immediate: true })

  watch(() => catStore.model.forceMouseMove, (value) => {
    if (value) return

    forcedMouseState.value = void 0

    pendingMouseDelta.value = { x: 0, y: 0 }

    void cursorPosition().then((point) => {
      if (catStore.model.forceMouseMove) return

      latestCursorPoint.value = { x: point.x, y: point.y }
    })
  })

  const startListening = () => {
    invoke(INVOKE_KEY.START_DEVICE_LISTENING)
  }

  const getSupportedKey = (key: string) => {
    let nextKey = key

    const unsupportedKey = !modelStore.supportKeys[nextKey]

    if (key.startsWith('F') && unsupportedKey) {
      nextKey = key.replace(/F(\d+)/, 'Fn')
    }

    for (const item of ['Meta', 'Shift', 'Alt', 'Control']) {
      if (key.startsWith(item) && unsupportedKey) {
        const regex = new RegExp(`^(${item}).*`)
        nextKey = key.replace(regex, '$1')
      }
    }

    return nextKey
  }

  const onHideOnHover = (() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let wasInWindow = false

    return (x: number, y: number) => {
      const { x: winX, y: winY, width, height } = appStore.windowState[WINDOW_LABEL.MAIN] ?? {}

      if (isNil(winX) || isNil(winY) || isNil(width) || isNil(height)) return

      const isInWindow = inBetween(x, winX, winX + width)
        && inBetween(y, winY, winY + height)

      if (isInWindow === wasInWindow) return

      if (timer) {
        clearTimeout(timer)

        timer = void 0
      }

      if (isInWindow) {
        timer = setTimeout(() => {
          document.body.style.setProperty('opacity', '0')

          appWindow.setIgnoreCursorEvents(true)
        }, catStore.window.hideOnHoverDelay * 1000)
      } else {
        document.body.style.setProperty('opacity', 'unset')

        appWindow.setIgnoreCursorEvents(catStore.window.passThrough)
      }

      wasInWindow = isInWindow
    }
  })()

  const handleCursorMove = async (cursorPoint: CursorPoint) => {
    const x = cursorPoint.x * scaleFactor.value
    const y = cursorPoint.y * scaleFactor.value

    handleMouseMove(new PhysicalPosition(x, y))

    if (!catStore.window.hideOnHover) return

    onHideOnHover(x, y)
  }

  const handleAutoRelease = (key: string, delay = 100) => {
    handlePress(key)

    if (releaseTimers.has(key)) {
      clearTimeout(releaseTimers.get(key))
    }

    const timer = setTimeout(() => {
      handleRelease(key)

      releaseTimers.delete(key)
    }, delay)

    releaseTimers.set(key, timer)
  }

  useTauriListen<DeviceEvent>(LISTEN_KEY.DEVICE_CHANGED, ({ payload }) => {
    const { kind, value } = payload

    if (kind === 'KeyboardPress' || kind === 'KeyboardRelease') {
      const nextValue = getSupportedKey(value)

      if (!nextValue) return

      if (nextValue === 'CapsLock') {
        return handleAutoRelease(nextValue)
      }

      if (kind === 'KeyboardPress') {
        if (isWindows) {
          const delay = catStore.model.autoReleaseDelay * 1000

          return handleAutoRelease(nextValue, delay)
        }

        return handlePress(nextValue)
      }

      return handleRelease(nextValue)
    }

    switch (kind) {
      case 'MousePress':
        return handleMouseChange(value)
      case 'MouseRelease':
        return handleMouseChange(value, false)
      case 'MouseDelta':
        return handleMouseDelta(value)
      case 'MouseMove':
        if (isWindows && catStore.model.forceMouseMove) {
          return void switchMonitorForAbsoluteCursor(value)
        }

        return latestCursorPoint.value = value
    }
  })

  return {
    startListening,
  }
}

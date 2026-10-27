// Window Controls Overlay (WCO) is a Chromium API that Electron exposes on
// Windows and Linux when `titleBarOverlay` is set. TypeScript's DOM library does
// not include it yet, so the shape is declared here instead of casting to `any`
// at every call site.

interface WindowControlsOverlayGeometry {
  x: number
  y: number
  width: number
  height: number
  top: number
  right: number
  bottom: number
  left: number
}

interface WindowControlsOverlay extends EventTarget {
  /** True when the OS is drawing the caption buttons over the page. */
  readonly visible: boolean
  /** The rectangle the OS reserved for the caption buttons and drag area. */
  getTitlebarAreaRect(): WindowControlsOverlayGeometry
}

interface Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlay
}

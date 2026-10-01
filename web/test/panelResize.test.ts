// @vitest-environment jsdom
import { act, createElement, useState } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { PanelResizeHandle } from "@/components/PanelResizeHandle"

it("resizes with the keyboard, clamps bounds and follows the panel edge", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  function Panel({ direction = 1 }: { direction?: 1 | -1 }) {
    const [width, setWidth] = useState(340)
    return createElement(PanelResizeHandle, {
      label: "Resize events",
      value: width,
      min: 320,
      max: 400,
      direction,
      onChange: setWidth,
    })
  }
  const press = (key: string) =>
    act(() => {
      host.firstElementChild!.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true })
      )
    })
  try {
    act(() => root.render(createElement(Panel)))
    const handle = host.firstElementChild as HTMLElement
    handle.focus()
    press("ArrowRight")
    expect(handle.getAttribute("aria-valuenow")).toBe("356")
    expect(document.activeElement).toBe(handle)
    press("End")
    press("ArrowRight")
    expect(handle.getAttribute("aria-valuenow")).toBe("400")
    press("Home")
    press("ArrowLeft")
    expect(handle.getAttribute("aria-valuenow")).toBe("320")
    act(() => root.render(createElement(Panel, { direction: -1 })))
    press("ArrowLeft")
    expect(handle.getAttribute("aria-valuenow")).toBe("336")
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

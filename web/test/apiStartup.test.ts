import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ accessToken: async () => null }))
import { api } from "@/lib/api"

const starting = () => Response.json({ error: "api starting" }, { status: 503 })

describe("API startup recovery", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("recovers a GET when Vite is ready before the API", async () => {
    vi.useFakeTimers()
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(starting())
      .mockResolvedValueOnce(Response.json([]))
    vi.stubGlobal("fetch", fetch)
    const response = api.events()
    await vi.advanceTimersByTimeAsync(500)
    expect(await response).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("keeps ordinary service failures visible", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: "Database unavailable" }, { status: 503 })
      )
    vi.stubGlobal("fetch", fetch)
    await expect(api.events()).rejects.toThrow("Database unavailable")
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("never replays writes", async () => {
    const fetch = vi.fn().mockResolvedValue(starting())
    vi.stubGlobal("fetch", fetch)
    await expect(api.saveSettings({ city: "San Diego, CA" })).rejects.toThrow(
      "api starting"
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("bounds the retry window if the API never starts", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockImplementation(async () => starting())
    vi.stubGlobal("fetch", fetch)
    const response = expect(api.events()).rejects.toThrow("api starting")
    await vi.advanceTimersByTimeAsync(4000)
    await response
    expect(fetch).toHaveBeenCalledTimes(9)
  })
})

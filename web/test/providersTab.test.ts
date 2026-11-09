// @vitest-environment jsdom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const calls = vi.hoisted(() => ({
  runtime: vi.fn(),
  mcpInfo: vi.fn(),
  saveSettings: vi.fn(),
  providerLogo: vi.fn(),
  providers: vi.fn(),
  testProvider: vi.fn(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: calls,
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { ProvidersTab } from "@/components/admin/ProvidersTab"
import { useGrapevine } from "@/lib/store"
import type { LlmProviderId, Settings } from "@/lib/types"

const settings = (
  chatProvider: LlmProviderId,
  extractProvider: LlmProviderId
): Settings => ({
  city: "Testville",
  center: [0, 0],
  tz: "UTC",
  model: "test-model",
  ollamaUrl: "",
  chatProvider,
  extractProvider,
  guardMode: "on",
  guardThreshold: 0.8,
})

let host: HTMLDivElement
let root: Root

async function render(chat: LlmProviderId, extract: LlmProviderId) {
  useGrapevine.setState({ settings: settings(chat, extract) })
  await act(async () => root.render(createElement(ProvidersTab)))
}

const switchBack = () =>
  [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Switch back")
  )

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  calls.runtime.mockResolvedValue({
    id: "ollama",
    name: "Ollama",
    url: "http://localhost:11434",
    version: "0.20.0",
    model: "test-model",
  })
  calls.mcpInfo.mockResolvedValue({
    url: "http://localhost:8787/mcp",
    transport: "http",
    auth: "oauth",
    connectorUrl: "http://localhost:8787/mcp",
  })
  calls.providerLogo.mockResolvedValue("")
  calls.providers.mockResolvedValue([
    {
      id: "codex",
      ready: true,
      version: "0.167.0",
      model: "gpt-6-astra",
      message: "Signed in on the API server",
    },
    {
      id: "claude",
      ready: true,
      version: "2.1.312",
      model: "best",
      message: "Signed in on the API server",
    },
  ])
  host = document.createElement("div")
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it("offers independent providers with official login commands and diagnostics", async () => {
  await render("ollama", "ollama")
  const text = host.textContent ?? ""
  expect(text).toContain("Ollama (local)")
  expect(text).toContain("v0.20.0 · test-model")
  expect(switchBack()).toBeUndefined()
  expect(host.querySelectorAll("select")).toHaveLength(2)
  expect(text).toContain("codex login")
  expect(text).toContain("claude auth login")
  expect(text).toContain("gpt-6-astra")
  expect(text).toContain("Signed in on the API server")
  expect(text).toContain("Connect Claude to Grapevine (MCP)")
})

it("names a saved CLI, says what it breaks, and switches back in one click", async () => {
  calls.saveSettings.mockResolvedValue(settings("ollama", "ollama"))
  await render("copilot", "gemini")
  const text = host.textContent ?? ""
  expect(text).toContain(
    "Ask Grapevine is still set to Copilot CLI, so chat answers with an error."
  )
  expect(text).toContain("Newsletter extraction is still set to Gemini CLI")
  expect(text).toContain("This saved provider is unsupported.")

  await act(async () =>
    switchBack()!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  )
  expect(calls.saveSettings).toHaveBeenCalledWith({
    chatProvider: "ollama",
    extractProvider: "ollama",
  })
  expect(switchBack()).toBeUndefined()
  expect(host.textContent).not.toContain("still set to")
  expect(useGrapevine.getState().settings?.chatProvider).toBe("ollama")
})

it("only mentions the role that is still on a CLI", async () => {
  await render("ollama", "gemini")
  const text = host.textContent ?? ""
  expect(text).toContain("Newsletter extraction is still set to Gemini CLI")
  expect(text).not.toContain("Ask Grapevine is still set to")
})

it("names vLLM when that is the runtime, and leaves Models out of it", async () => {
  calls.runtime.mockResolvedValue({
    id: "vllm",
    name: "vLLM",
    url: "http://127.0.0.1:8000",
    version: "0.33.0",
    model: "pinned-model",
  })
  await render("ollama", "ollama")
  const text = host.textContent ?? ""
  expect(text).toContain("vLLM (local)")
  expect(text).toContain("v0.33.0 · pinned-model")
  expect(text).toContain("one pinned model")
  expect(text).not.toContain("Models tab")
})

it("says the runtime is unreachable when it does not answer", async () => {
  calls.runtime.mockResolvedValue({
    id: "ollama",
    name: "Ollama",
    url: "http://localhost:11434",
    version: null,
    model: "",
  })
  await render("ollama", "ollama")
  expect(host.textContent).toContain("unreachable · no model picked")
})

it("saves just the changed role and keeps the local model", async () => {
  calls.saveSettings.mockResolvedValue(settings("codex", "ollama"))
  await render("ollama", "ollama")
  const select = host.querySelector("select")!
  await act(async () => {
    select.value = "codex"
    select.dispatchEvent(new Event("change", { bubbles: true }))
  })
  expect(calls.saveSettings).toHaveBeenCalledWith({ chatProvider: "codex" })
  expect(useGrapevine.getState().settings?.model).toBe("test-model")
  expect(switchBack()).toBeUndefined()
})

it("runs an explicit connection test and displays its result", async () => {
  calls.testProvider.mockResolvedValue({ ok: true })
  await render("codex", "claude")
  const test = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Test ChatGPT connection"
  )!
  await act(async () =>
    test.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  )
  expect(calls.testProvider).toHaveBeenCalledWith("codex")
  expect(host.textContent).toContain("structured response validated")
})

it("keeps setup instructions visible when provider diagnostics fail", async () => {
  calls.providers.mockRejectedValue(new Error("down"))
  await render("ollama", "ollama")
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Provider checks failed"
  )
  expect(host.textContent).toContain("codex login")
})

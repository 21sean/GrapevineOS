/**
 * The agent's toolbox as LangChain structured tools: every "graph" contract
 * from contracts.ts bound to its executor, built per request so each tool
 * closes over the same immutable event snapshot the system prompt was
 * written from.
 *
 * Two kinds of executor:
 *  - data tools (search_events, get_event, get_eta, the web tools) run here
 *    and return JSON the model reads;
 *  - UI tools (show_on_map, set_filters, propose_calendar, update_interests)
 *    emit an "action" frame to the browser via the LangGraph custom-stream
 *    writer and return a receipt telling the model what the user will see.
 *
 * Names, descriptions and schemas are not written here. Adding a tool is one
 * contract entry plus one executor below; the type of `exec` makes a missing
 * executor a compile error rather than a runtime "unknown tool".
 */
import { tool } from "@langchain/core/tools";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { saveEventForUser } from "../calendar.js";
import { clampCadence, runDiscovery, summarizeRejections } from "../discovery.js";
import { store } from "../store.js";
import type { AgentFrame, Filters } from "../types.js";
import { toolsFor, type ToolArgs, type ToolsOn } from "./contracts.js";
import {
  INTEREST_TOPICS,
  getEta,
  getEvent,
  searchEvents,
  setEventRarity,
  vetEventIds,
  vetTopics,
  type AgentCtx,
  type ChatContext,
} from "./context.js";
import { readPage, webSearch } from "./websearch.js";

/** Push a typed frame onto the "custom" stream (a no-op outside a streamed run). */
export function emit(config: LangGraphRunnableConfig | undefined, frame: AgentFrame): void {
  config?.writer?.(frame);
}

type GraphTool = ToolsOn<"graph">;
type Executor<N extends GraphTool> = (
  input: ToolArgs<N>,
  config?: LangGraphRunnableConfig,
) => Promise<string>;
type Executors = { [N in GraphTool]: Executor<N> };

const noIds = JSON.stringify({
  error: "no valid event ids — use ids from the digest or search results",
});

export function makeTools(ctx: AgentCtx, chat: ChatContext) {
  const exec: Executors = {
    search_events: async (input) => JSON.stringify(await searchEvents(input, ctx)),

    get_event: async (input) => JSON.stringify(getEvent(input.id, ctx)),

    get_eta: async (input) => JSON.stringify(await getEta(input, ctx)),

    // Returns what the web said, verbatim. The content rail is a graph node
    // (graph.ts): it scans this result before the model is called again, so
    // every web-facing tool is covered by one rail instead of each tool
    // remembering to call the classifier itself.
    search_web: async (input, config) =>
      JSON.stringify(await webSearch(input.query, { limit: input.limit, signal: config?.signal })),

    // Untrusted by definition; scanned by the content_rail node (graph.ts).
    read_page: async (input, config) =>
      JSON.stringify(await readPage(input.url, { signal: config?.signal })),

    discover_events: async (input, config) => {
      const commit = input.dry_run === false;
      // Chat keeps latency tolerable by reading fewer pages than a scheduled
      // run; the verification gate (source-quote check, LLM cross-read,
      // catalog dedupe) is identical.
      const run = await runDiscovery({ query: input.query, commit, maxPages: 3 });
      if (commit && run.added > 0) {
        emit(config, { type: "action", action: { kind: "eventsRefresh", count: run.added } });
      }
      // Grouped "why" for the rejected candidates, so a thin run is actionable
      // (explain it to the user, retry tighter) instead of a silent 0.
      const topReasons = summarizeRejections(run.rejected);
      const note = commit
        ? run.added > 0
          ? `${run.added} new event(s) are in the catalog now, already visible in the user's list and map.`
          : run.verified.length > 0
            ? "every verified event was already in the catalog; nothing new to add."
            : run.extracted > 0
              ? "found candidates but none could be verified against their source pages; see rejected_reasons, then try a tighter or different query."
              : "no event listings found on the pages read; try a different query."
        : run.verified.length > 0
          ? "dry run, nothing written. Re-run with dry_run:false to add the verified events."
          : "dry run; nothing passed verification. See rejected_reasons before spending another run.";
      return JSON.stringify({
        query: run.query,
        dry_run: !commit,
        pages_read: run.pagesRead.length,
        extracted: run.extracted,
        verified: run.verified.slice(0, 12).map((c) => ({
          title: c.event.title,
          start: c.event.start,
          venue: c.event.venue,
          source_url: c.sourceUrl,
          confidence: c.confidence,
        })),
        rejected: run.rejected.length,
        ...(topReasons.length && { rejected_reasons: topReasons }),
        added: run.added,
        ...(run.error && { error: run.error }),
        note,
      });
    },

    show_on_map: async (input, config) => {
      const ids = vetEventIds(input.event_ids, ctx);
      if (!ids.length) return noIds;
      emit(config, { type: "action", action: { kind: "highlight", eventIds: ids, fit: true } });
      return JSON.stringify({
        ok: true,
        pinned: ids.length,
        note: `Highlighted ${ids.length} event${ids.length === 1 ? "" : "s"} on the user's map.`,
      });
    },

    set_filters: async (input, config) => {
      // Only forward the knobs the model actually set; the client merges the
      // patch into its current filters (or resets first when asked).
      const patch: Partial<Filters> = {
        ...(input.categories !== undefined && { categories: input.categories }),
        ...(input.live_only !== undefined && { liveOnly: input.live_only }),
        ...(input.rare_only !== undefined && { rareOnly: input.rare_only }),
        ...(input.free_only !== undefined && { freeOnly: input.free_only }),
        ...(input.farmers !== undefined && { farmers: input.farmers }),
        ...(input.hide_promoted !== undefined && { hidePromoted: input.hide_promoted }),
        ...(input.min_buzz !== undefined && {
          minRating: Math.min(5, Math.max(0, input.min_buzz)),
        }),
        ...(input.date_from !== undefined && { dateFrom: input.date_from }),
        ...(input.date_to !== undefined && { dateTo: input.date_to }),
      };
      if (!input.reset && Object.keys(patch).length === 0) {
        return JSON.stringify({ error: "set at least one filter (or reset:true)" });
      }
      emit(config, {
        type: "action",
        action: {
          kind: "setFilters",
          reset: Boolean(input.reset),
          patch,
          ...(input.note ? { note: input.note.slice(0, 120) } : {}),
        },
      });
      return JSON.stringify({
        ok: true,
        applied: { reset: Boolean(input.reset), ...patch },
        note: "The user's map and list now show only matching events. They see a notice and can undo.",
      });
    },

    list_scheduled_searches: async () => {
      const user = chat.sessionUser;
      if (!user) {
        return JSON.stringify({
          error: "the user is signed out — watches belong to an account; suggest signing in",
        });
      }
      const watches = await store.discoverySearches({ userId: user.id });
      return JSON.stringify({
        count: watches.length,
        watches: watches.map((w) => ({
          id: w.id,
          query: w.query,
          cadence_hours: w.cadenceHours,
          active: w.active,
          last_run_at: w.lastRunAt ?? null,
          last_status: w.lastStatus ?? null,
        })),
      });
    },

    propose_watch: async (input, config) => {
      const cadenceHours = clampCadence(input.cadence_hours);
      emit(config, {
        type: "action",
        action: {
          kind: "proposeWatch",
          query: input.query,
          cadenceHours,
          ...(input.note ? { note: input.note.slice(0, 120) } : {}),
        },
      });
      return JSON.stringify({
        ok: true,
        proposed: { query: input.query, cadence_hours: cadenceHours },
        note: chat.sessionUser
          ? "Watch card shown; the user confirms. Do not claim it is set."
          : "Watch card shown; the user is signed out and will be asked to sign in first.",
      });
    },

    propose_calendar: async (input, config) => {
      const ids = vetEventIds(input.event_ids, ctx);
      if (!ids.length) return noIds;
      emit(config, {
        type: "action",
        action: {
          kind: "proposeCalendar",
          eventIds: ids,
          ...(input.note ? { note: input.note.slice(0, 120) } : {}),
        },
      });
      return (
        `Save card shown for ${ids.length} event${ids.length === 1 ? "" : "s"}. ` +
        (chat.signedIn
          ? "The user will confirm; do not claim anything is saved."
          : "The user is signed out and will be asked to sign in first.")
      );
    },

    save_calendar: async (input, config) => {
      const user = chat.sessionUser;
      if (!user) {
        return JSON.stringify({
          error: "user is signed out — use propose_calendar so they can sign in and confirm",
        });
      }
      const ids = vetEventIds(input.event_ids, ctx);
      if (!ids.length) return noIds;
      const saved: string[] = [];
      let googleSynced = 0;
      for (const id of ids) {
        const result = await saveEventForUser(user, id);
        if ("error" in result) continue;
        saved.push(id);
        if (result.googleSynced) googleSynced++;
      }
      if (!saved.length) return JSON.stringify({ error: "nothing could be saved" });
      emit(config, { type: "action", action: { kind: "calendarSaved", eventIds: saved } });
      return JSON.stringify({
        ok: true,
        saved,
        google_synced: googleSynced,
        note:
          "Saved to the user's Grapevine calendar" + (googleSynced ? " and Google Calendar" : ""),
      });
    },

    set_rarity: async (input, config) => {
      const result = await setEventRarity(input.event_id, input.rarity, ctx);
      if ("error" in result) return JSON.stringify(result);
      // The DB is already updated; tell the browser so badges and the
      // "Rare finds" filter reflect it without a reload.
      emit(config, { type: "action", action: { kind: "eventPatched", event: result.event } });
      return JSON.stringify({
        ok: true,
        id: result.event.id,
        title: result.event.title,
        rarity: result.event.rarity,
        note: result.changed ? "saved" : "already had this rarity",
      });
    },

    update_interests: async (input, config) => {
      const addLoves = vetTopics(input.add_loves);
      const addAvoids = vetTopics(input.add_avoids);
      const removeLoves = vetTopics(input.remove_loves);
      const removeAvoids = vetTopics(input.remove_avoids);
      if (!addLoves.length && !addAvoids.length && !removeLoves.length && !removeAvoids.length)
        return JSON.stringify({
          error: `no valid topics — use only: ${INTEREST_TOPICS.join(", ")}`,
        });
      emit(config, {
        type: "action",
        action: {
          kind: "proposeInterests",
          addLoves,
          addAvoids,
          removeLoves,
          removeAvoids,
          reason: String(input.reason ?? "").slice(0, 160),
        },
      });
      return "Interest update proposed; the user will confirm.";
    },
  };

  const run = exec as Record<
    string,
    (input: unknown, config?: LangGraphRunnableConfig) => Promise<string>
  >;
  return toolsFor("graph").map((c) =>
    tool(async (input: unknown, config?: LangGraphRunnableConfig) => run[c.name](input, config), {
      name: c.name,
      description: c.description,
      schema: c.schema,
    }),
  );
}

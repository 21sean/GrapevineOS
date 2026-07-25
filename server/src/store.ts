/**
 * Data layer — Supabase Postgres via supabase-js (see db.ts).
 *
 * Every method mirrors the old JSON-file store one-to-one so route handlers
 * keep their shapes, but reads/writes now hit real tables. App types
 * (CityEvent, User, …) stay camelCase; the row mappers below translate to
 * the snake_case columns in db-types.ts.
 */
import crypto from "node:crypto";
import { dayInTz } from "../../shared/time.js";
import { db } from "./db.js";
import { normalizeRRule } from "./recurrence.js";
import type { Json, Tables, TablesInsert } from "./db-types.js";
import { isLlmProviderId } from "./types.js";
import type {
  CalendarEntry,
  ChatMessage,
  ChatThreadMeta,
  CityEvent,
  DiscoverySearch,
  GoogleCalendarGrant,
  IngestRecord,
  PushSub,
  Reaction,
  ReactionEntry,
  Settings,
  Source,
  User,
  UserPrefs,
} from "./types.js";

/** Stable dedupe key, enforced by a unique index on events.dedupe_key so
 * ingest dedupe is a DB guarantee. One-offs key on normalized title + the
 * city-local start day (so the same instant keys identically no matter which
 * UTC offset a source emitted it with, and two same-title events on different
 * local days stay distinct). Recurring events key on title + the recurrence
 * rule (a stable "series key"), so re-ingesting next week's newsletter
 * updates the one series row instead of spawning a duplicate per occurrence. */
export function eventKey(
  e: Pick<CityEvent, "title" | "start" | "recurrence">,
  tz: string,
): string {
  const title = e.title.toLowerCase().replace(/[^a-z0-9]/g, "");
  const rule = normalizeRRule(e.recurrence);
  return rule ? `${title}|${rule}` : `${title}|${dayInTz(e.start, tz)}`;
}

/** DB stores providers as free text; unknown values fall back to ollama. */
function coerceProvider(v: string): Settings["chatProvider"] {
  return isLlmProviderId(v) ? v : "ollama";
}

// ---------- row mappers ----------

function rowToEvent(r: Tables<"events">): CityEvent {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    category: r.category,
    tags: r.tags,
    venue: r.venue,
    address: r.address ?? undefined,
    lng: r.lng,
    lat: r.lat,
    start: r.starts_at,
    end: r.ends_at,
    recurrence: r.recurrence ?? undefined,
    price: r.price,
    free: r.is_free,
    ticketUrl: r.ticket_url ?? undefined,
    ticketProvider: r.ticket_provider ?? undefined,
    source: r.source_id,
    sourceKind: r.source_kind,
    sourceUrl: r.source_url ?? undefined,
    rating: Number(r.rating),
    ratingRationale: r.rating_rationale ?? undefined,
    promoted: r.promoted,
    rarity: r.rarity,
    imageUrl: r.image_url ?? undefined,
    imageColor: r.image_color ?? undefined,
  };
}

function eventToRow(e: CityEvent, tz: string): TablesInsert<"events"> {
  // The DB enforces ends_at >= starts_at; clamp instead of losing the event
  // when the LLM emits a sloppy end time.
  const end = new Date(e.end) >= new Date(e.start) ? e.end : e.start;
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    category: e.category,
    tags: e.tags,
    venue: e.venue,
    address: e.address ?? null,
    lng: e.lng,
    lat: e.lat,
    starts_at: e.start,
    ends_at: end,
    // Normalize on write so every path stores a canonical rule (or null) and
    // never trips the events.recurrence check constraint.
    recurrence: normalizeRRule(e.recurrence),
    price: e.price,
    is_free: e.free,
    ticket_url: e.ticketUrl ?? null,
    ticket_provider: e.ticketProvider ?? null,
    source_id: e.source,
    source_kind: e.sourceKind,
    source_url: e.sourceUrl ?? null,
    rating: e.rating,
    rating_rationale: e.ratingRationale ?? null,
    promoted: e.promoted,
    rarity: e.rarity,
    image_url: e.imageUrl ?? null,
    image_color: e.imageColor ?? null,
    dedupe_key: eventKey(e, tz),
  };
}

type UserRow = Tables<"users"> & {
  // join carries only non-secret metadata — the refresh token stays in Vault
  user_google_calendar: Pick<Tables<"user_google_calendar">, "scope"> | null;
};

const USER_SELECT = "*, user_google_calendar(scope)" as const;

function rowToUser(r: UserRow): User {
  const g = r.user_google_calendar;
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    picture: r.picture,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    prefs: (r.prefs ?? {}) as UserPrefs,
    ...(g && { googleCalendar: { scope: g.scope } satisfies GoogleCalendarGrant }),
    feedToken: r.feed_token ?? undefined,
    ...(r.last_lng !== null &&
      r.last_lat !== null &&
      r.last_pos_at !== null && {
        lastPos: { lng: r.last_lng, lat: r.last_lat, at: r.last_pos_at },
      }),
  };
}

function rowToCalendarEntry(r: Tables<"calendar_entries">): CalendarEntry {
  return {
    userId: r.user_id,
    eventId: r.event_id,
    googleEventId: r.google_event_id ?? undefined,
    addedAt: r.added_at,
  };
}

function rowToPushSub(r: Tables<"push_subscriptions">): PushSub {
  return {
    id: r.id,
    userId: r.user_id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    reminders: r.reminders,
    weeklyDigest: r.weekly_digest,
    leaveBy: r.leave_by,
  };
}

function rowToDiscoverySearch(r: Tables<"discovery_searches">): DiscoverySearch {
  return {
    id: r.id,
    query: r.query,
    cadenceHours: r.cadence_hours,
    active: r.active,
    createdAt: r.created_at,
    lastRunAt: r.last_run_at ?? undefined,
    lastStatus: r.last_status || undefined,
  };
}

function rowToIngest(r: Tables<"ingests">): IngestRecord {
  return {
    id: r.id,
    receivedAt: r.received_at,
    source: r.source,
    kind: r.kind,
    subject: r.subject ?? undefined,
    extracted: r.extracted,
    added: r.added,
    events: (r.events ?? []) as IngestRecord["events"],
  };
}

export const store = {
  // ---------- events ----------

  async events(): Promise<CityEvent[]> {
    const { data } = await db
      .from("events")
      .select("*")
      .order("starts_at", { ascending: true })
      .throwOnError();
    return data.map(rowToEvent);
  },

  async eventById(id: string): Promise<CityEvent | undefined> {
    const { data } = await db
      .from("events")
      .select("*")
      .eq("id", id)
      .maybeSingle()
      .throwOnError();
    return data ? rowToEvent(data) : undefined;
  },

  /**
   * Adds events. A batch row whose dedupe_key already exists refreshes the
   * stored copy in place (content fields only — the row keeps its id, rarity,
   * and enriched image so reactions, calendar saves, and admin edits survive
   * a re-ingest). Unknown source slugs are auto-registered so the events FK
   * always holds. Returns only the newly inserted events, so ingest logs and
   * image enrichment keep meaning "new on the map."
   */
  async addEvents(incoming: CityEvent[]): Promise<CityEvent[]> {
    const { tz } = await this.settings();
    // Drop unparseable dates up front — one bad row would fail the batch.
    const valid = incoming.filter(
      (e) => Number.isFinite(Date.parse(e.start)) && Number.isFinite(Date.parse(e.end)),
    );
    // First occurrence wins within a batch, like the old in-memory dedupe.
    const seen = new Set<string>();
    const batch = valid.filter((e) => {
      const k = eventKey(e, tz);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (!batch.length) return [];

    const slugs = [...new Set(batch.map((e) => e.source))];
    await db
      .from("sources")
      .upsert(
        slugs.map((id) => ({
          id,
          name: id,
          kind: "derived",
          note: "Auto-registered from ingested events.",
          active: false,
        })),
        { onConflict: "id", ignoreDuplicates: true },
      )
      .throwOnError();

    const rows = batch.map((e) => eventToRow(e, tz));
    const { data } = await db
      .from("events")
      .upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true })
      .select()
      .throwOnError();
    const insertedKeys = new Set(data.map((r) => r.dedupe_key));

    // Conflicting keys were left untouched by the insert — refresh their
    // content so a corrected time/venue/price from a re-send actually lands.
    for (const row of rows) {
      if (insertedKeys.has(row.dedupe_key)) continue;
      await db
        .from("events")
        .update({
          title: row.title,
          description: row.description,
          category: row.category,
          tags: row.tags,
          venue: row.venue,
          address: row.address,
          lng: row.lng,
          lat: row.lat,
          starts_at: row.starts_at,
          ends_at: row.ends_at,
          recurrence: row.recurrence,
          price: row.price,
          is_free: row.is_free,
          ticket_url: row.ticket_url,
          ticket_provider: row.ticket_provider,
          rating: row.rating,
          rating_rationale: row.rating_rationale,
          promoted: row.promoted,
        })
        .eq("dedupe_key", row.dedupe_key)
        .throwOnError();
    }
    return data.map(rowToEvent);
  },

  async updateEvent(id: string, patch: Partial<CityEvent>): Promise<CityEvent | undefined> {
    // Same ends_at >= starts_at guarantee the insert path (eventToRow) gives:
    // clamp against the effective pair instead of tripping the DB constraint.
    if (patch.start !== undefined || patch.end !== undefined) {
      const current = await this.eventById(id);
      if (!current) return undefined;
      const start = patch.start ?? current.start;
      const end = patch.end ?? current.end;
      patch = {
        ...patch,
        start,
        end: new Date(end) >= new Date(start) ? end : start,
      };
    }
    const { data } = await db
      .from("events")
      .update({
        ...(patch.title !== undefined && { title: patch.title }),
        ...(patch.description !== undefined && { description: patch.description }),
        ...(patch.category !== undefined && { category: patch.category }),
        ...(patch.tags !== undefined && { tags: patch.tags }),
        ...(patch.venue !== undefined && { venue: patch.venue }),
        ...(patch.address !== undefined && { address: patch.address ?? null }),
        ...(patch.lng !== undefined && { lng: patch.lng }),
        ...(patch.lat !== undefined && { lat: patch.lat }),
        ...(patch.start !== undefined && { starts_at: patch.start }),
        ...(patch.end !== undefined && { ends_at: patch.end }),
        ...(patch.recurrence !== undefined && {
          recurrence: normalizeRRule(patch.recurrence),
        }),
        ...(patch.price !== undefined && { price: patch.price }),
        ...(patch.free !== undefined && { is_free: patch.free }),
        ...(patch.ticketUrl !== undefined && { ticket_url: patch.ticketUrl ?? null }),
        ...(patch.ticketProvider !== undefined && {
          ticket_provider: patch.ticketProvider ?? null,
        }),
        ...(patch.rating !== undefined && { rating: patch.rating }),
        ...(patch.ratingRationale !== undefined && {
          rating_rationale: patch.ratingRationale ?? null,
        }),
        ...(patch.promoted !== undefined && { promoted: patch.promoted }),
        ...(patch.rarity !== undefined && { rarity: patch.rarity }),
        ...(patch.imageUrl !== undefined && { image_url: patch.imageUrl ?? null }),
        ...(patch.imageColor !== undefined && { image_color: patch.imageColor ?? null }),
      })
      .eq("id", id)
      .select()
      .maybeSingle()
      .throwOnError();
    return data ? rowToEvent(data) : undefined;
  },

  // ---------- settings (singleton row) ----------

  async settings(): Promise<Settings> {
    const { data } = await db
      .from("app_settings")
      .select("*")
      .eq("id", 1)
      .maybeSingle()
      .throwOnError();
    if (!data) {
      return {
        city: "San Diego, CA",
        center: [-117.1611, 32.7157],
        tz: "America/Los_Angeles",
        model: "",
        ollamaUrl: "",
        chatProvider: "ollama",
        extractProvider: "ollama",
      };
    }
    return {
      city: data.city,
      center: [data.center_lng, data.center_lat],
      tz: data.tz,
      model: data.model,
      ollamaUrl: data.ollama_url,
      chatProvider: coerceProvider(data.chat_provider),
      extractProvider: coerceProvider(data.extract_provider),
    };
  },

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.settings()), ...patch };
    await db
      .from("app_settings")
      .upsert({
        id: 1,
        city: next.city,
        center_lng: next.center[0],
        center_lat: next.center[1],
        tz: next.tz,
        model: next.model,
        ollama_url: next.ollamaUrl,
        chat_provider: next.chatProvider,
        extract_provider: next.extractProvider,
      })
      .throwOnError();
    return next;
  },

  // ---------- sources ----------

  async sources(): Promise<Source[]> {
    const { data } = await db
      .from("sources")
      .select("*")
      .order("created_at", { ascending: true })
      .throwOnError();
    return data.map((r) => ({
      id: r.id,
      name: r.name,
      address: r.address,
      kind: r.kind,
      note: r.note,
      active: r.active,
    }));
  },

  // ---------- ingest history ----------

  async ingests(): Promise<IngestRecord[]> {
    const { data } = await db
      .from("ingests")
      .select("*")
      .order("received_at", { ascending: false })
      .limit(200)
      .throwOnError();
    return data.map(rowToIngest);
  },

  async logIngest(r: Omit<IngestRecord, "id" | "receivedAt">): Promise<IngestRecord> {
    const { data } = await db
      .from("ingests")
      .insert({
        source: r.source,
        kind: r.kind,
        subject: r.subject ?? null,
        extracted: r.extracted,
        added: r.added,
        events: r.events,
      })
      .select()
      .single()
      .throwOnError();
    return rowToIngest(data);
  },

  // ---------- discovery searches (scheduled web searches) ----------

  async discoverySearches(): Promise<DiscoverySearch[]> {
    const { data } = await db
      .from("discovery_searches")
      .select("*")
      .order("created_at", { ascending: true })
      .throwOnError();
    return data.map(rowToDiscoverySearch);
  },

  async discoverySearchById(id: string): Promise<DiscoverySearch | undefined> {
    const { data } = await db
      .from("discovery_searches")
      .select("*")
      .eq("id", id)
      .maybeSingle()
      .throwOnError();
    return data ? rowToDiscoverySearch(data) : undefined;
  },

  /** Upsert keyed on the normalized query, so re-adding a search updates it. */
  async addDiscoverySearch(query: string, cadenceHours: number): Promise<DiscoverySearch> {
    const { data } = await db
      .from("discovery_searches")
      .upsert(
        { query: query.trim(), cadence_hours: cadenceHours, active: true },
        { onConflict: "query_key" },
      )
      .select()
      .single()
      .throwOnError();
    return rowToDiscoverySearch(data);
  },

  async updateDiscoverySearch(
    id: string,
    patch: Partial<Pick<DiscoverySearch, "cadenceHours" | "active">>,
  ): Promise<DiscoverySearch | undefined> {
    const { data } = await db
      .from("discovery_searches")
      .update({
        ...(patch.cadenceHours !== undefined && { cadence_hours: patch.cadenceHours }),
        ...(patch.active !== undefined && { active: patch.active }),
      })
      .eq("id", id)
      .select()
      .maybeSingle()
      .throwOnError();
    return data ? rowToDiscoverySearch(data) : undefined;
  },

  async deleteDiscoverySearch(id: string): Promise<boolean> {
    const { data } = await db
      .from("discovery_searches")
      .delete()
      .eq("id", id)
      .select("id")
      .throwOnError();
    return data.length > 0;
  },

  /** Stamp a run's outcome; the scheduler keys "due" off last_run_at. */
  async markDiscoveryRun(id: string, status: string): Promise<void> {
    await db
      .from("discovery_searches")
      .update({ last_run_at: new Date().toISOString(), last_status: status.slice(0, 300) })
      .eq("id", id)
      .throwOnError();
  },

  // ---------- users ----------

  /**
   * JIT profile upsert keyed on the verified auth.users id. The DB trigger
   * on auth.users normally creates this row at signup; this covers a request
   * racing that trigger and refreshes profile fields as a side effect.
   */
  async upsertProfile(p: Pick<User, "id" | "email" | "name" | "picture">): Promise<User> {
    const { data } = await db
      .from("users")
      .upsert(
        {
          id: p.id,
          email: p.email,
          name: p.name,
          picture: p.picture,
          last_login_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      )
      .select(USER_SELECT)
      .single()
      .throwOnError();
    return rowToUser(data as UserRow);
  },

  async userById(id: string): Promise<User | undefined> {
    const { data } = await db
      .from("users")
      .select(USER_SELECT)
      .eq("id", id)
      .maybeSingle()
      .throwOnError();
    return data ? rowToUser(data as UserRow) : undefined;
  },

  /** Lookup for the external agent API's AGENT_USER_EMAIL binding. */
  async userByEmail(email: string): Promise<User | undefined> {
    const { data } = await db
      .from("users")
      .select(USER_SELECT)
      .ilike("email", email)
      .limit(1)
      .maybeSingle()
      .throwOnError();
    return data ? rowToUser(data as UserRow) : undefined;
  },

  async updateUserPrefs(id: string, prefs: UserPrefs): Promise<User | undefined> {
    const current = await this.userById(id);
    if (!current) return undefined;
    const { data } = await db
      .from("users")
      .update({ prefs: { ...current.prefs, ...prefs } as Json })
      .eq("id", id)
      .select(USER_SELECT)
      .maybeSingle()
      .throwOnError();
    return data ? rowToUser(data as UserRow) : undefined;
  },

  /**
   * Last coarse position, the origin for leave-by departure ETAs. Snapped to
   * a ~110 m grid before it ever reaches a row — the alerts don't need more
   * precision, so the DB never learns more than that.
   */
  async setUserPosition(id: string, lng: number, lat: number): Promise<void> {
    const snap = (n: number) => Math.round(n * 1000) / 1000;
    await db
      .from("users")
      .update({
        last_lng: snap(lng),
        last_lat: snap(lat),
        last_pos_at: new Date().toISOString(),
      })
      .eq("id", id)
      .throwOnError();
  },

  /**
   * Stores the user's Google Calendar refresh token in Supabase Vault via
   * the service-role-only RPC (encrypted at rest, never a plaintext column).
   */
  async setGoogleCalendarToken(userId: string, refreshToken: string, scope: string): Promise<void> {
    await db
      .rpc("google_calendar_set", {
        p_user_id: userId,
        p_refresh_token: refreshToken,
        p_scope: scope,
      })
      .throwOnError();
  },

  /** Decrypts the stored refresh token, or null when not connected. */
  async googleCalendarToken(userId: string): Promise<{ refreshToken: string; scope: string } | null> {
    const { data } = await db
      .rpc("google_calendar_get", { p_user_id: userId })
      .throwOnError();
    const row = data?.[0];
    return row ? { refreshToken: row.refresh_token, scope: row.scope } : null;
  },

  /** Drops the grant; a DB trigger scrubs the Vault secret with it. */
  async clearGoogleCalendarToken(userId: string): Promise<void> {
    await db.rpc("google_calendar_clear", { p_user_id: userId }).throwOnError();
  },

  /** Mints the unguessable ICS-feed token on first use, then reuses it. */
  async ensureFeedToken(id: string): Promise<string | undefined> {
    const user = await this.userById(id);
    if (!user) return undefined;
    if (user.feedToken) return user.feedToken;
    const token = crypto.randomBytes(16).toString("hex");
    const { data } = await db
      .from("users")
      .update({ feed_token: token })
      .eq("id", id)
      .is("feed_token", null)
      .select("feed_token")
      .maybeSingle()
      .throwOnError();
    // Lost a race with a concurrent request — theirs won, use it.
    return data?.feed_token ?? (await this.userById(id))?.feedToken;
  },

  async userByFeedToken(token: string): Promise<User | undefined> {
    if (!token) return undefined;
    const { data } = await db
      .from("users")
      .select(USER_SELECT)
      .eq("feed_token", token)
      .maybeSingle()
      .throwOnError();
    return data ? rowToUser(data as UserRow) : undefined;
  },

  // ---------- calendar (per-user saved events) ----------

  async userCalendar(userId: string): Promise<CalendarEntry[]> {
    const { data } = await db
      .from("calendar_entries")
      .select("*")
      .eq("user_id", userId)
      .throwOnError();
    return data.map(rowToCalendarEntry);
  },

  /** Add-or-update, keyed by (userId, eventId) — saving twice is a no-op. */
  async upsertCalendarEntry(
    userId: string,
    eventId: string,
    patch?: Partial<CalendarEntry>,
  ): Promise<CalendarEntry> {
    const { data } = await db
      .from("calendar_entries")
      .upsert(
        {
          user_id: userId,
          event_id: eventId,
          // Only touch google_event_id when the caller sets it, so a plain
          // re-save never wipes an existing Google link.
          ...(patch?.googleEventId !== undefined && {
            google_event_id: patch.googleEventId,
          }),
        },
        { onConflict: "user_id,event_id" },
      )
      .select()
      .single()
      .throwOnError();
    return rowToCalendarEntry(data);
  },

  async removeCalendarEntry(userId: string, eventId: string): Promise<void> {
    await db
      .from("calendar_entries")
      .delete()
      .eq("user_id", userId)
      .eq("event_id", eventId)
      .throwOnError();
  },

  /** After a Google disconnect the synced copies are unreachable — the
   * entries just forget their Google ids. */
  async clearGoogleEventIds(userId: string): Promise<void> {
    await db
      .from("calendar_entries")
      .update({ google_event_id: null })
      .eq("user_id", userId)
      .throwOnError();
  },

  // ---------- chat history (Ask Grapevine, signed-in users only) ----------

  /** Who owns a thread id, or null when it doesn't exist yet. */
  async chatThreadOwner(threadId: string): Promise<string | null> {
    const { data } = await db
      .from("chat_threads")
      .select("user_id")
      .eq("id", threadId)
      .maybeSingle()
      .throwOnError();
    return data?.user_id ?? null;
  },

  /** Newest-first thread list for the history panel. */
  async chatThreads(userId: string): Promise<ChatThreadMeta[]> {
    const { data } = await db
      .from("chat_threads")
      .select("id, title, provider, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(100)
      .throwOnError();
    return data.map((r) => ({
      id: r.id,
      title: r.title,
      provider: r.provider,
      updatedAt: r.updated_at,
    }));
  },

  /** Full transcript of one thread — only if `userId` owns it. */
  async chatMessages(userId: string, threadId: string): Promise<ChatMessage[] | null> {
    if ((await this.chatThreadOwner(threadId)) !== userId) return null;
    const { data } = await db
      .from("chat_messages")
      .select("role, content, created_at")
      .eq("thread_id", threadId)
      .order("id", { ascending: true })
      .limit(500)
      .throwOnError();
    return data.map((r) => ({
      role: r.role as ChatMessage["role"],
      content: r.content,
      createdAt: r.created_at,
    }));
  },

  /**
   * Persist one exchange. Creates the thread on first use (titled from the
   * opening message) and bumps updated_at so the history list stays sorted.
   * Ownership must be checked by the caller before the turn ever runs.
   */
  async appendChatTurn(
    userId: string,
    threadId: string,
    provider: string,
    turn: { userText: string; assistantText: string },
  ): Promise<void> {
    const owner = await this.chatThreadOwner(threadId);
    if (owner && owner !== userId) return; // never write into someone else's thread
    if (!owner) {
      await db
        .from("chat_threads")
        .insert({
          id: threadId,
          user_id: userId,
          title: turn.userText.replace(/\s+/g, " ").slice(0, 80),
          provider,
        })
        .throwOnError();
    } else {
      await db
        .from("chat_threads")
        .update({ provider })
        .eq("id", threadId)
        .throwOnError();
    }
    await db
      .from("chat_messages")
      .insert([
        { thread_id: threadId, role: "user", content: turn.userText },
        { thread_id: threadId, role: "assistant", content: turn.assistantText },
      ])
      .throwOnError();
  },

  async deleteChatThread(userId: string, threadId: string): Promise<boolean> {
    if ((await this.chatThreadOwner(threadId)) !== userId) return false;
    await db.from("chat_threads").delete().eq("id", threadId).throwOnError();
    return true;
  },

  // ---------- reactions (per-user event feedback) ----------

  async userReactions(userId: string): Promise<ReactionEntry[]> {
    const { data } = await db
      .from("event_reactions")
      .select("event_id, reaction")
      .eq("user_id", userId)
      .throwOnError();
    return data.map((r) => ({ eventId: r.event_id, reaction: r.reaction }));
  },

  /** Set (upsert) or clear (null) a user's reaction to an event. */
  async setReaction(userId: string, eventId: string, reaction: Reaction | null): Promise<void> {
    if (!reaction) {
      await db
        .from("event_reactions")
        .delete()
        .eq("user_id", userId)
        .eq("event_id", eventId)
        .throwOnError();
      return;
    }
    await db
      .from("event_reactions")
      .upsert(
        { user_id: userId, event_id: eventId, reaction },
        { onConflict: "user_id,event_id" },
      )
      .throwOnError();
  },

  // ---------- web push ----------

  async pushKeys(): Promise<{ publicKey: string; privateKey: string } | null> {
    const { data } = await db
      .from("push_keys")
      .select("*")
      .eq("id", 1)
      .maybeSingle()
      .throwOnError();
    return data ? { publicKey: data.public_key, privateKey: data.private_key } : null;
  },

  /** First writer wins — a concurrent boot race keeps one stable key pair. */
  async savePushKeys(keys: { publicKey: string; privateKey: string }): Promise<void> {
    await db
      .from("push_keys")
      .upsert(
        { id: 1, public_key: keys.publicKey, private_key: keys.privateKey },
        { onConflict: "id", ignoreDuplicates: true },
      )
      .throwOnError();
  },

  async upsertPushSub(
    sub: Omit<PushSub, "id" | "reminders" | "weeklyDigest" | "leaveBy"> &
      Partial<Pick<PushSub, "reminders" | "weeklyDigest" | "leaveBy">>,
  ): Promise<void> {
    await db
      .from("push_subscriptions")
      .upsert(
        {
          user_id: sub.userId,
          endpoint: sub.endpoint,
          p256dh: sub.p256dh,
          auth: sub.auth,
          ...(sub.reminders !== undefined && { reminders: sub.reminders }),
          ...(sub.weeklyDigest !== undefined && { weekly_digest: sub.weeklyDigest }),
          ...(sub.leaveBy !== undefined && { leave_by: sub.leaveBy }),
        },
        { onConflict: "endpoint" },
      )
      .throwOnError();
  },

  async updatePushSubPrefs(
    userId: string,
    endpoint: string,
    prefs: Partial<Pick<PushSub, "reminders" | "weeklyDigest" | "leaveBy">>,
  ): Promise<void> {
    await db
      .from("push_subscriptions")
      .update({
        ...(prefs.reminders !== undefined && { reminders: prefs.reminders }),
        ...(prefs.weeklyDigest !== undefined && { weekly_digest: prefs.weeklyDigest }),
        ...(prefs.leaveBy !== undefined && { leave_by: prefs.leaveBy }),
      })
      .eq("user_id", userId)
      .eq("endpoint", endpoint)
      .throwOnError();
  },

  /** Scoped to the user so nobody can unsubscribe someone else's endpoint. */
  async deletePushSub(userId: string, endpoint: string): Promise<void> {
    await db
      .from("push_subscriptions")
      .delete()
      .eq("user_id", userId)
      .eq("endpoint", endpoint)
      .throwOnError();
  },

  /** Endpoint died (410/404 from the push service) — drop it everywhere. */
  async deletePushEndpoint(endpoint: string): Promise<void> {
    await db.from("push_subscriptions").delete().eq("endpoint", endpoint).throwOnError();
  },

  async pushSubsForUser(userId: string): Promise<PushSub[]> {
    const { data } = await db
      .from("push_subscriptions")
      .select("*")
      .eq("user_id", userId)
      .throwOnError();
    return data.map(rowToPushSub);
  },

  async allPushSubs(): Promise<PushSub[]> {
    const { data } = await db.from("push_subscriptions").select("*").throwOnError();
    return data.map(rowToPushSub);
  },

  /**
   * Idempotency gate for scheduled sends: true exactly once per key, even
   * when two ticks (or two server instances) race — the primary key decides.
   */
  async tryMarkSent(key: string): Promise<boolean> {
    const { data } = await db
      .from("push_sends")
      .upsert({ key }, { onConflict: "key", ignoreDuplicates: true })
      .select()
      .throwOnError();
    return data.length > 0;
  },

};

/**
 * Data layer — Supabase Postgres via supabase-js (see db.ts).
 *
 * Every method mirrors the old JSON-file store one-to-one so route handlers
 * keep their shapes, but reads/writes now hit real tables. App types
 * (CityEvent, User, …) stay camelCase; the row mappers below translate to
 * the snake_case columns in db-types.ts.
 */
import crypto from "node:crypto";
import { db } from "./db.js";
import { normalizeRRule } from "./recurrence.js";
import type { Json, Tables, TablesInsert } from "./db-types.js";
import type {
  CalendarEntry,
  CityEvent,
  GoogleTokens,
  IngestRecord,
  Settings,
  Source,
  User,
  UserPrefs,
} from "./types.js";

/** Stable dedupe key, enforced by a unique index on events.dedupe_key so
 * ingest dedupe is a DB guarantee. One-offs key on normalized title + start
 * date. Recurring events key on title + the recurrence rule (a stable "series
 * key"), so re-ingesting next week's newsletter updates the one series row
 * instead of spawning a duplicate per occurrence. */
export function eventKey(e: Pick<CityEvent, "title" | "start" | "recurrence">): string {
  const title = e.title.toLowerCase().replace(/[^a-z0-9]/g, "");
  const rule = normalizeRRule(e.recurrence);
  return rule ? `${title}|${rule}` : `${title}|${e.start.slice(0, 10)}`;
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
    rating: Number(r.rating),
    ratingRationale: r.rating_rationale ?? undefined,
    promoted: r.promoted,
    rarity: r.rarity,
  };
}

function eventToRow(e: CityEvent): TablesInsert<"events"> {
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
    rating: e.rating,
    rating_rationale: e.ratingRationale ?? null,
    promoted: e.promoted,
    rarity: e.rarity,
    dedupe_key: eventKey(e),
  };
}

type UserRow = Tables<"users"> & {
  user_google_tokens: Tables<"user_google_tokens"> | null;
};

const USER_SELECT = "*, user_google_tokens(*)" as const;

function rowToUser(r: UserRow): User {
  const t = r.user_google_tokens;
  return {
    id: r.id,
    googleId: r.google_id,
    email: r.email,
    name: r.name,
    picture: r.picture,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    prefs: (r.prefs ?? {}) as UserPrefs,
    ...(t && {
      google: {
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        expiresAt: new Date(t.expires_at).getTime(),
        scope: t.scope,
      } satisfies GoogleTokens,
    }),
    feedToken: r.feed_token ?? undefined,
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
   * Adds events, skipping duplicates (same normalized title + start date).
   * Unknown source slugs are auto-registered so the events FK always holds.
   * Returns the ones actually added.
   */
  async addEvents(incoming: CityEvent[]): Promise<CityEvent[]> {
    // Drop unparseable dates up front — one bad row would fail the batch.
    const valid = incoming.filter(
      (e) => Number.isFinite(Date.parse(e.start)) && Number.isFinite(Date.parse(e.end)),
    );
    // First occurrence wins within a batch, like the old in-memory dedupe.
    const seen = new Set<string>();
    const batch = valid.filter((e) => {
      const k = eventKey(e);
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

    const { data } = await db
      .from("events")
      .upsert(batch.map(eventToRow), { onConflict: "dedupe_key", ignoreDuplicates: true })
      .select()
      .throwOnError();
    return data.map(rowToEvent);
  },

  async updateEvent(id: string, patch: Partial<CityEvent>): Promise<CityEvent | undefined> {
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
      };
    }
    return {
      city: data.city,
      center: [data.center_lng, data.center_lat],
      tz: data.tz,
      model: data.model,
      ollamaUrl: data.ollama_url,
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

  // ---------- users ----------

  /** Find-or-create by Google id; refreshes profile fields on every login. */
  async upsertUser(p: Pick<User, "googleId" | "email" | "name" | "picture">): Promise<User> {
    const { data } = await db
      .from("users")
      .upsert(
        {
          google_id: p.googleId,
          email: p.email,
          name: p.name,
          picture: p.picture,
          last_login_at: new Date().toISOString(),
        },
        { onConflict: "google_id" },
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

  /** Stores (or clears, with null) the user's Google Calendar OAuth grant. */
  async setGoogleTokens(userId: string, tokens: GoogleTokens | null): Promise<void> {
    if (!tokens) {
      await db.from("user_google_tokens").delete().eq("user_id", userId).throwOnError();
      return;
    }
    await db
      .from("user_google_tokens")
      .upsert({
        user_id: userId,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: new Date(tokens.expiresAt).toISOString(),
        scope: tokens.scope,
      })
      .throwOnError();
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

  // ---------- sessions ----------

  /** Creates a session and returns the raw token for the cookie. */
  async createSession(userId: string, ttlMs: number): Promise<string> {
    const token = crypto.randomBytes(32).toString("hex");
    await db
      .from("sessions")
      .insert({
        token_hash: hashToken(token),
        user_id: userId,
        expires_at: new Date(Date.now() + ttlMs).toISOString(),
      })
      .throwOnError();
    // Opportunistic cleanup, same as the JSON store; pg_cron also purges daily.
    await db.from("sessions").delete().lt("expires_at", new Date().toISOString());
    return token;
  },

  async deleteSession(token: string): Promise<void> {
    await db.from("sessions").delete().eq("token_hash", hashToken(token)).throwOnError();
  },

  async sessionUser(token: string): Promise<User | null> {
    const { data } = await db
      .from("sessions")
      .select("expires_at, users(*, user_google_tokens(*))")
      .eq("token_hash", hashToken(token))
      .gt("expires_at", new Date().toISOString())
      .maybeSingle()
      .throwOnError();
    const user = data?.users as unknown as UserRow | null | undefined;
    return user ? rowToUser(user) : null;
  },
};

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

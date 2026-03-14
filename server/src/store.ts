import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CityEvent, Session, Settings, Source, User, UserPrefs } from "./types.js";

const DATA_DIR = path.resolve(import.meta.dirname, "../data");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown) {
  const target = path.join(DATA_DIR, file);
  const tmp = target + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
}

/** Stable dedupe key: normalized title + start date. */
export function eventKey(e: Pick<CityEvent, "title" | "start">): string {
  return (
    e.title.toLowerCase().replace(/[^a-z0-9]/g, "") + "|" + e.start.slice(0, 10)
  );
}

export const store = {
  events(): CityEvent[] {
    return readJson<CityEvent[]>("events.json", []);
  },

  saveEvents(events: CityEvent[]) {
    writeJson("events.json", events);
  },

  /** Adds events, skipping duplicates. Returns the ones actually added. */
  addEvents(incoming: CityEvent[]): CityEvent[] {
    const existing = this.events();
    const keys = new Set(existing.map(eventKey));
    const added: CityEvent[] = [];
    for (const e of incoming) {
      const k = eventKey(e);
      if (keys.has(k)) continue;
      keys.add(k);
      added.push(e);
    }
    if (added.length) this.saveEvents([...existing, ...added]);
    return added;
  },

  updateEvent(id: string, patch: Partial<CityEvent>): CityEvent | undefined {
    const events = this.events();
    const idx = events.findIndex((e) => e.id === id);
    if (idx === -1) return undefined;
    events[idx] = { ...events[idx], ...patch, id };
    this.saveEvents(events);
    return events[idx];
  },

  settings(): Settings {
    return readJson<Settings>("settings.json", {
      city: "Denver, CO",
      center: [-104.9903, 39.7392],
      tz: "America/Denver",
      model: "",
      ollamaUrl: "",
    });
  },

  saveSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings(), ...patch };
    writeJson("settings.json", next);
    return next;
  },

  sources(): Source[] {
    return readJson<Source[]>("sources.json", []);
  },

  // ---------- users & sessions ----------

  users(): User[] {
    return readJson<User[]>("users.json", []);
  },

  saveUsers(users: User[]) {
    writeJson("users.json", users);
  },

  /** Find-or-create by Google id; refreshes profile fields on every login. */
  upsertUser(p: Pick<User, "googleId" | "email" | "name" | "picture">): User {
    const users = this.users();
    const now = new Date().toISOString();
    const idx = users.findIndex((u) => u.googleId === p.googleId);
    if (idx !== -1) {
      users[idx] = { ...users[idx], ...p, lastLoginAt: now };
      this.saveUsers(users);
      return users[idx];
    }
    const user: User = { id: crypto.randomUUID(), ...p, createdAt: now, lastLoginAt: now };
    this.saveUsers([...users, user]);
    return user;
  },

  userById(id: string): User | undefined {
    return this.users().find((u) => u.id === id);
  },

  updateUserPrefs(id: string, prefs: UserPrefs): User | undefined {
    const users = this.users();
    const idx = users.findIndex((u) => u.id === id);
    if (idx === -1) return undefined;
    users[idx] = { ...users[idx], prefs: { ...users[idx].prefs, ...prefs } };
    this.saveUsers(users);
    return users[idx];
  },

  sessions(): Session[] {
    return readJson<Session[]>("sessions.json", []);
  },

  /** Creates a session and returns the raw token for the cookie. */
  createSession(userId: string, ttlMs: number): string {
    const token = crypto.randomBytes(32).toString("hex");
    const live = this.sessions().filter((s) => s.expiresAt > Date.now());
    live.push({ tokenHash: hashToken(token), userId, expiresAt: Date.now() + ttlMs });
    writeJson("sessions.json", live);
    return token;
  },

  deleteSession(token: string) {
    const hash = hashToken(token);
    writeJson(
      "sessions.json",
      this.sessions().filter((s) => s.tokenHash !== hash && s.expiresAt > Date.now()),
    );
  },

  sessionUser(token: string): User | null {
    const hash = hashToken(token);
    const s = this.sessions().find((x) => x.tokenHash === hash && x.expiresAt > Date.now());
    return s ? (this.userById(s.userId) ?? null) : null;
  },
};

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

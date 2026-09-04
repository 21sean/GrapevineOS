# UX feature ideas

Potential features that would improve the user experience, grounded in a full
read of the current web client, server API, and docs. Nothing here duplicates
what already exists (single-event sharing, date quick chips, leave-by alerts,
weekly digest, pins/hide, reactions, ICS/webcal, voice input, thread history,
same-venue marker paging, search-dimmed markers, dynamic map lighting are all
already shipped). Each idea notes why it matters, where it would land in the
code, and a rough size (S / M / L).

A shortlist of the highest leverage-to-effort picks is at the end.

---

## 1. First-run and onboarding

### 1.1 Taste bootstrap on first visit (M)

The personal ranking (`web/src/lib/score.ts`) is the product's core, but a new
visitor starts with an empty `interests` and no reactions, so "Relevance" is
just buzz order. A one-time, skippable prompt ("pick a few things you're
into") that opens the existing `InterestsDialog` pre-framed for first-run, or
a lighter "pick 3 of these 9 events you'd actually go to" card that seeds
loves from their tags, would make the very first list feel personal instead
of generic.

### 1.2 Coach marks for the hidden power features (S)

Ask Grapevine (⌘K), the live tour play button, drag-to-resize panels, and the
farmers tri-state are all discoverable only by accident. A dismissible
three-step spotlight on first load (stored in the existing zustand `persist`
slice) would surface them without a tutorial page.

### 1.3 Signed-out value explainer (S)

Signing in unlocks cross-device prefs, reactions that follow you, the digest,
and calendar sync, but `SignInDialog.tsx` only shows provider buttons. One
sentence of "what you get" copy plus a hint on the reaction row when
signed-out ("saved to this browser; sign in to keep them") sets expectations.

## 2. Map and discovery

### 2.1 "Search this area" viewport filter (M)

The list and map share one filtered set, but panning the map never affects
the list, and there is no distance control anywhere in the manual UI (the
agent already supports `near`/`max_km` in `search_events`). After the user
pans/zooms, show the standard "Search this area" pill; while active, the rail
list narrows to the viewport. This closes the loop between the two halves of
the screen.

### 2.2 Near-me radius chip (S)

`userPos` is already captured and `useEta` proves the plumbing. Add a "Near
me" quick chip next to Today/Tomorrow/Weekend that filters to events within a
radius (e.g. 3 km, tappable to cycle 1/3/8 km). Mobile especially benefits.

### 2.3 Map layers control, and restore the traffic toggle (S)

`trafficOn` exists in the store but `setTraffic` is wired to no UI, and the
README still claims "Traffic layer toggles from the top bar" (stale). A small
layers popover on the map (traffic on/off, light preset auto/day/night) fixes
a real regression and gives the 3D basemap some user agency.

### 2.4 Tap a tag to filter (S)

Tags on `EventDetail` are display-only badges. Making them tappable (sets
`searchQuery` or a proper tag filter) turns every event page into a discovery
pivot: "food trucks" on one event finds the others.

### 2.5 Time scrubber / "map at 8pm Friday" (L)

The recurrence engine (`web/src/lib/recurrence.ts`) can expand occurrences at
an arbitrary instant. A timeline scrubber along the bottom of the map that
re-renders markers for a chosen hour (with the basemap light preset
following) would answer "what's around on Friday night" visually. Large but
very differentiating.

### 2.6 Buzz heatmap layer (M)

A toggleable heat layer weighted by `rating` gives a glanceable "where is the
action this weekend" view at low zoom, complementing the per-event pins that
only work when zoomed in.

## 3. Planning and itineraries

### 3.1 Night-plan builder with route legs (L)

Users can save individual events to the calendar, but there is no way to
string a Friday together. An "Add to plan" action on cards/detail builds an
ordered mini-itinerary (sorted by start time), draws the legs on the map, and
shows per-leg ETAs and leave-by times reusing `GET /api/eta` and the push
scheduler's leave-by math. The agent's `propose_calendar` flow already proves
the save-all UX; this is the manual sibling.

### 3.2 Shareable plans and views (M)

Sharing is single-event only (`?event=` deep link). Two extensions:
`?events=id1,id2,id3` renders a shared pin set with a "save all" bar (the
`CalendarCard` component already does save-all), and `?filters=` encodes the
current filter state so "free live music this weekend" is a sendable link.
No accounts or storage needed; it is all client-side URL state.

### 3.3 An "Interested" shelf distinct from pins (M)

Pins are list-ordering; calendar saves are commitments. There is no
"maybe/later" bucket. An `interested` reaction (or a saved-for-later shelf in
`AccountDialog`) that boosts score mildly and collects into its own section
fills the gap between "going" and nothing, and gives the digest better
signal.

### 3.4 Overlap warnings on saved events (S)

When two calendar-saved events overlap in time, badge the conflict in
`EventDetail` and the week digest, and let the personal score suggest which
one wins. All the data is already client-side.

## 4. Lightweight social (privacy-first)

### 4.1 Anonymous "N locals going" counts (M)

Reactions are stored server-side per user but surfaced only as private
signal. An aggregate count (shown only above a small threshold, e.g. 3+, to
avoid deanonymizing) on `EventCard`/`EventDetail` turns the reaction system
into the product's own buzz metric, which is exactly the brand promise.
Needs one aggregate endpoint and a badge.

### 4.2 "Join me" event invites outside Google Calendar (S)

The share sheet sends a bare link. A "Join me" variant that pre-fills share
text with title/time/venue, and an RSVP-less "N friends opened this" is not
needed; keep it dumb. Cheap polish on an existing feature.

## 5. Notifications and re-engagement

### 5.1 Post-event follow-up prompt (M)

The taste loop depends on users remembering to tap "Went — great" after the
fact, which nobody does. The morning after a calendar-saved event, send an
optional push (and show an in-app card) asking "Did you make it to X?" with
the two reaction buttons inline. This single feature probably improves the
learned ranking more than anything else on this list.

### 5.2 Rare-find alert (M)

The ingest pipeline knows the moment a `rarity: "rare"` or high-buzz event
matching the user's loves lands. An opt-in fourth switch in the existing
notifications panel ("Rare finds — a few per month, only when it matches your
taste") uses infrastructure that already exists (`push.ts` scheduler,
interest matching in the digest scorer).

### 5.3 In-app notification history (S)

Pushes are fire-and-forget; a dismissed "leave by 6:38" is gone. A small bell
popover listing the last N notifications (reminders, leave-by, digest) with
jump-to-event links means missing a push is not missing the event.

### 5.4 Digest controls (S)

The Sunday digest is fixed. Let users pick the day/time and picks-per-day in
`AccountDialog`, and add an optional "tonight" mini-digest (a 4pm push on
days with a strong match).

## 6. Personalization, accessibility, platform

### 6.1 Light theme / system theme (M)

The app is dark-only (`Toaster theme="dark"` is hard-coded and the palette
assumes night). The map already has day light presets, so a light theme is
mostly CSS-variable work plus a three-way toggle (system/dark/light) in the
account dialog. Broad daylight use (farmers markets are a headline category)
argues for it.

### 6.2 "Why am I seeing this?" score explainer (S)

`lib/score.ts` already computes named components (rare boost, love match,
reaction history, free nudge). Surface them as a small tooltip or detail row:
"Boosted for you: jazz + free + rare." Trust in the ranking is the product;
showing the reasoning builds it. The digest already has `ratingRationale`
precedent.

### 6.3 Mute a venue or source (S)

Hide is per-event only. "See less from this venue" / "Mute this source" in
the card's hover menu (persisted next to `hiddenIds`) handles the recurring
offender problem without per-occurrence whack-a-mole.

### 6.4 PWA install affordance and offline snapshot (M)

Safe-area and standalone CSS exist, but nothing invites installation. Add a
web manifest + install prompt, and cache the last event list so the app opens
to yesterday's map offline instead of a spinner. The audience (out on the
town, patchy signal) hits this constantly.

### 6.5 Reduced-data and text-size options (S)

A "skip images" switch (og:images are the heaviest asset; `imageColor`
placeholders already exist as the fallback) and a text-size bump serve slow
connections and accessibility with minimal work.

## 7. Agent

### 7.1 Contextual opener suggestions (S)

The empty-state suggestion chips are static. Make them time-aware ("It's
Friday afternoon — plan my night?", "3 new rare finds this week — see them?")
using data already in the store. Zero new backend.

### 7.2 End-user web discovery requests (M)

Web discovery (search → verify → map) is operator-only in the Admin sheet.
Expose a guarded version through the agent: "find upcoming pickleball
tournaments" runs `discover_events` with the existing verification gate, and
shows results as the standard proposal-card flow pending the user's save.
The safety rails (deterministic checks + skeptical second pass) already
exist; this is permissioning plus UI.

## 8. Small quality-of-life wins (all S)

- **Tonight chip**: Today spans the whole day; a "Tonight" chip (17:00 to
  close) matches how people actually decide.
- **Keyboard list navigation**: arrow keys / j-k through the rail list,
  Enter to open detail, Escape already clears search.
- **Copy address** button next to Directions in `EventDetail`; use Apple
  Maps for the directions link on iOS devices.
- **Countdown in detail**: "starts in 2h 10m" derived from the existing
  30-second clock tick.
- **Undo for filter reset**: hide has undo toasts; "Reset filters" in the
  empty state should too.
- **Fix the stale README claim** about the traffic toggle (or better, close
  it with 2.3).

---

## Shortlist: best leverage for the effort

1. **Post-event follow-up prompt (5.1)** — directly strengthens the taste
   loop everything else feeds on.
2. **"Search this area" + near-me chip (2.1, 2.2)** — closes the map/list
   loop; the biggest everyday interaction gap.
3. **Traffic/layers toggle (2.3)** — fixes a shipped regression the README
   still advertises.
4. **Score explainer (6.2)** — cheap, and makes the core ranking legible and
   trustworthy.
5. **Shareable plans/views (3.2)** — turns a single-player app into one that
   recruits its own users, with no backend changes.

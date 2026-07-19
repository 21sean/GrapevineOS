/**
 * The one place a CityEvent becomes calendar-entry text. Google sync
 * (gcal.ts) and ICS export (ics.ts) both render from this, so the same event
 * can't read differently depending on which calendar it landed in.
 */
import type { CityEvent } from "./types.js";

export function calendarEventBody(e: CityEvent): {
  description: string;
  location: string;
} {
  return {
    description: [
      e.description,
      e.ticketUrl ? `Tickets: ${e.ticketUrl}` : "",
      `via Grapevine (${e.source})`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    location: e.address ? `${e.venue}, ${e.address}` : e.venue,
  };
}

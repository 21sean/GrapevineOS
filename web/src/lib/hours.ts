/**
 * Opening-hours parsing lives in shared/hours.ts: one implementation for the
 * web client and the server, so "Open now" can't mean two different things.
 * The server hands over Mapbox's raw OSM string and the client evaluates it
 * against its own clock, so the answer stays true inside the server's cache
 * window.
 */
export {
  parseOpeningHours,
  openState,
  clockLabel,
  localWeekMinutes,
  type Interval,
  type OpeningHours,
  type OpenState,
} from "../../../shared/hours"

# README screenshot settings

Captured from the running v0.7.0 application on 2026-10-28 using the live event
catalog. These are browser screenshots, with no compositing or image retouching.
Events, counts, and Mapbox geometry can change between captures.

## Scene

Look southeast from San Diego Bay toward the Embarcadero and downtown skyline.
The desktop composition includes the Star of India at the Maritime Museum,
near longitude -117.17353, latitude 32.72042
([landmark location](https://www.californiahistoricallandmarks.com/landmarks/chl-1030)).

In **Map layers**, use these settings:

| Setting            | Value |
| ------------------ | ----- |
| Lighting           | Dark  |
| 3D buildings       | On    |
| Points of interest | Off   |
| Place names        | Off   |
| Street names       | Off   |
| Transit            | Off   |
| Walking paths      | Off   |
| Live traffic       | Off   |

Pause and minimize the happening-now tour. Keep the filter disclosure closed and
the search field empty. The captured event list uses a minimum buzz rating of 4.0
and hides promoted events; date, category, live-only, rare-only, free-only, and
distance restrictions are unset. These are capture-session preferences, not
changes to application defaults.

## Framing

Camera centers are `[longitude, latitude]`; bearing and pitch are degrees.
Padding is in CSS pixels. The camera was positioned on the existing Mapbox
instance in the browser; application source and event data were not edited for
the screenshots.

| Asset                       | Viewport    | Center                  | Zoom  | Pitch | Bearing | Padding (top / right / bottom / left) |
| --------------------------- | ----------- | ----------------------- | ----- | ----- | ------- | ------------------------------------- |
| `downtown-san-diego-3d.png` | 1600 × 1000 | `[-117.1727, 32.72045]` | 17.15 | 75    | 132     | `40 / 0 / 0 / 310`                    |
| `mobile-event-list.png`     | 430 × 932   | `[-117.1727, 32.72045]` | 16.3  | 78    | 132     | `80 / 0 / 360 / 0`                    |
| `mobile-event-details.png`  | 430 × 932   | `[-117.1727, 32.72045]` | 16.3  | 78    | 132     | `80 / 0 / 360 / 0`                    |

For the phone list, raise the bottom sheet to its half-open position. For the
detail capture, open **San Diego Veterans Day Parade** and restore the camera
after the selection fly-to. The detail sheet naturally covers most of the map.
Use a comparable public waterfront event if that event is no longer available.

Before saving, wait for map tiles, 3D geometry, sheet animations, and venue/ETA
requests to finish. Inspect each image at full size for clipped text, empty
states, loading indicators, and private account information. Keep the scene and
settings consistent across desktop and phone.

Map rendering: © Mapbox · © OpenStreetMap contributors.

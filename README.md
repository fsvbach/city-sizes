# City Sizes

**Live demo: <https://fsvbach.github.io/city-sizes/>**

Compares city sizes by overlaying their administrative boundaries (from
OpenStreetMap) true to scale — centered on the centroid of a selectable
reference city (the first loaded one by default).

Initial cities: **Zurich** (reference), **Mexico City**, **London**, **Berlin**,
**New York City**.
More cities can be added via the input field in the panel; the list shows the
official name resolved by Nominatim (not the typed query), so wrong matches
are visible immediately.

The radio buttons in the panel make a city the **reference location**: the
whole arrangement shifts rigidly so that city's outline matches its real
boundary on the map, and the background shows its actual surroundings. All
other cities keep their position relative to the group — switching the
reference never rearranges the assembly.

Cities can also be **moved around**: click an outline (it gets highlighted),
then drag it while holding the mouse button; clicking it again clears the
selection. Clicking the active reference radio re-aligns it with the map in
case it was dragged away.

Clicking a city's **color swatch** opens a color picker. The **Save** button
in the top bar exports the assembled comparison as a self-contained JSON file
(cities with boundary geometry, colors, manual offsets, and the reference
choice — hidden cities are not included); **Load** imports such a file and
replaces the current comparison — no Nominatim requests needed, so it also
works offline.

## Usage

Just open `index.html` in a browser – no installation needed.

```bash
open index.html
```

Alternatively, via a local server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

## How it works

1. **Loading boundaries** – Nominatim (`polygon_geojson=1`, simplified via
   `polygon_threshold`) returns the administrative boundary as GeoJSON.
   Responses are cached in `localStorage` for 7 days; requests run
   sequentially (max. 1/s, per the Nominatim usage policy).
2. **Projection** – Each city is projected equirectangularly into local
   **meters** around its area centroid (with `cos(φ)` correction of the
   longitudes). This preserves true size ratios even though the cities lie
   at different latitudes. Outlying islands and exclaves (e.g. Hamburg's
   Neuwerk, Tokyo's island chains) are excluded so they don't bias centroid,
   area, or extent: a part is dropped when its centroid is farther than 3×
   the main polygon's equivalent radius away, or when it is a tiny fragment
   (< 2 % of the main area) beyond 1× that radius (min. 20 km each).
   Contiguous city islands like New York's boroughs are kept.

   Note: some regions map administrative boundaries into the sea (Japanese
   prefectures include their territorial waters), which inflates the computed
   area beyond the official land area even after island filtering.
3. **Overlay** – The meter coordinates are converted back to lat/lng around
   the anchor point and drawn as semi-transparent polygons (largest city at
   the bottom, smallest on top). Area and extent are shown in the tooltip
   and the panel.

## Technologies

| Library | Purpose |
|---|---|
| [Leaflet.js](https://leafletjs.com/) | Interactive map |
| [CARTO Positron](https://carto.com/) | Muted greyscale tiles |
| [Nominatim](https://nominatim.org/) | City boundaries as GeoJSON |

## Data sources

- Map data: © OpenStreetMap contributors (ODbL), tiles © CARTO
- City boundaries: OpenStreetMap via Nominatim

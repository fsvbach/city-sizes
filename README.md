# City Sizes

Overlay city boundaries (from OpenStreetMap) true to scale to compare their
sizes — anchored to a reference city whose outline aligns with the real map
underneath.

**Live demo: <https://fsvbach.github.io/city-sizes/>**

![Zurich compared with Mexico City, London, Berlin, and New York](images/zurich-2.png)

## Features

- **Add cities** by name — Nominatim resolves the query, and the list shows
  the official name, so wrong matches stand out.
- **Reference city** (radio button): the whole arrangement shifts rigidly so
  that city's outline matches the map; relative positions are kept.
- **Move cities**: click an outline to select it, then drag. Clicking the
  active reference radio re-aligns it with the map.
- **Colors**: click a swatch to open a color picker.
- **Save / Load** (top bar): export/import the assembled comparison as
  self-contained JSON (geometry included, no network needed to load).
  Hidden cities are not saved.

## Usage

```bash
python3 -m http.server 8080   # then open http://localhost:8080
```

On startup the app loads `data/zurich-2.json`. To change the default, Save
your arrangement and point `DEFAULT_COMPARISON_URL` in `js/app.js` at the
file. When opened via `file://`, browsers block reading the default file —
use the Load button instead.

## How it works

Boundaries come from Nominatim as simplified GeoJSON (cached for 7 days,
max. 1 request/s). Each city is projected into local meters around its area
centroid (equirectangular, `cos(φ)`-corrected), which preserves true size
ratios across latitudes. Outlying islands and exclaves (Hamburg's Neuwerk,
Tokyo's island chains) are dropped so they don't bias centroid, area, or
extent, while contiguous city islands like New York's boroughs are kept.
The meter coordinates are then re-anchored on the reference city and drawn
with Leaflet (largest city at the bottom). Caveat: some regions map their
boundaries into the sea (e.g. Japanese prefectures), which inflates areas
beyond official land figures.

## Data

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors (ODbL) · tiles © [CARTO](https://carto.com/attributions) ·
boundaries via [Nominatim](https://nominatim.org/)

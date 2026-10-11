"""Step 2 — extract everything the walkability model needs for each city from
Overture Maps (GeoParquet on S3). Parquet footers are cached in memory, so after
a one-off warm-up each city downloads only the row groups it touches (a few MB).
Resumable: cities with an output file are skipped.

Per city it writes data-raw/ov/<id>.json.gz with:
  centre     the OSM/Overture locality point matching the city name
  places     [x, y, category] daily destinations (Overture places, confidence >= 0.5)
  stops      [x, y, kind]     transit stops (OSM via Overture base/infrastructure)
  crossings  [x, y]           mapped pedestrian crossings
  parks      [[ring], ...]    park polygons (Overture base/land_use)
  inter      [x, y]           walk-network nodes where 3+ street segments meet
  ped        [x, y, metres]   car-free ways (pedestrian streets, footpaths, steps)
  motorways / trunks          polylines
  hoods      neighbourhood / locality points and polygons (Overture divisions)

Usage: python pipeline/02-extract.py [--tiers 0-3] [--limit N] [--only id,id] [--shard i/n]
"""
import duckdb, gzip, json, math, os, re, sys, time, unicodedata

RELEASE = '2026-09-23.1'
R = f's3://overturemaps-us-west-2/release/{RELEASE}/'
RADIUS = 10_000                     # analysis radius around the centre, metres
MARGIN = {'pois': 1600, 'net': 600, 'geo': 800}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data-raw', 'ov')
os.makedirs(OUT, exist_ok=True)

args = dict(re.findall(r'--(\S+)\s+(\S+)', ' '.join(sys.argv[1:])))
tier_lo, tier_hi = map(int, args.get('tiers', '0-4').split('-'))
limit = int(args.get('limit', 10**9))
only = set(map(int, args['only'].split(','))) if 'only' in args else None
shard, shards = map(int, args.get('shard', '0/1').split('/'))

CATS = json.load(open(os.path.join(ROOT, 'docs', 'data', 'categories.json'), encoding='utf-8'))
CAT_NAMES = ['grocery', 'food', 'shops', 'health', 'education', 'parks', 'errands', 'culture']
CAT_OF = {oc: CAT_NAMES.index(c) for c in CAT_NAMES for oc in CATS[c]}
IN_LIST = ','.join(f"'{c}'" for c in CAT_OF)

con = duckdb.connect()
con.execute(f"""
  INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;
  SET s3_region='us-west-2'; SET enable_object_cache=true; SET enable_progress_bar=false; SET threads=8;
""")

def src(theme, typ):
    return f"read_parquet('{R}theme={theme}/type={typ}/*', hive_partitioning=0)"

def pad(b, m):
    s, w, n, e = b
    dlat = m / 110540
    dlon = m / (111320 * math.cos(math.radians((s + n) / 2)))
    return (s - dlat, w - dlon, n + dlat, e + dlon)

def inside(b):  # features whose bbox starts inside the box (points, small ways)
    s, w, n, e = b
    return f"bbox.xmin BETWEEN {w:.6f} AND {e:.6f} AND bbox.ymin BETWEEN {s:.6f} AND {n:.6f}"

def touches(b):  # features whose bbox intersects the box (polygons, long lines)
    s, w, n, e = b
    return f"bbox.xmax >= {w:.6f} AND bbox.xmin <= {e:.6f} AND bbox.ymax >= {s:.6f} AND bbox.ymin <= {n:.6f}"

def norm(s):
    s = unicodedata.normalize('NFD', s or '')
    s = ''.join(ch for ch in s if unicodedata.category(ch) != 'Mn').lower()
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()

def strip_generic(s):
    return re.sub(r'\b(city|ciudad|municipality|metropolitan|shi|si|gun)\b', '', s).strip()

def haversine(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(a))

r5 = lambda v: round(v, 5)

def geojson_rings(gj):
    g = json.loads(gj)
    t, c = g['type'], g['coordinates']
    if t == 'Polygon':
        return [[[r5(x), r5(y)] for x, y in ring] for ring in c]
    if t == 'MultiPolygon':
        return [[[r5(x), r5(y)] for x, y in ring] for poly in c for ring in poly]
    if t == 'LineString':
        return [[[r5(x), r5(y)] for x, y in c]]
    if t == 'MultiLineString':
        return [[[r5(x), r5(y)] for x, y in line] for line in c]
    return []

def pick_centre(t, divs):
    """The locality point for the city itself. The GHSL centroid can sit far from
    downtown (the Bay Area's is in the bay), so the urban centre's main name is
    matched first over a wide radius; its other member towns only as a fallback."""
    if t.get('fixedCentre'):
        return {'lat': t['lat'], 'lon': t['lon'], 'how': 'fixed'}
    rank = {'megacity': 0, 'city': 1, 'town': 2}
    def keys(d):
        return {k for c in (d['n'], d['en']) if c for k in (norm(c), strip_generic(norm(c)))}
    def best(cands):
        cands.sort(key=lambda d: (rank.get(d['class'], 3), -(d['pop'] or 0), haversine(t['lat'], t['lon'], d['y'], d['x'])))
        d = cands[0]
        return {'lat': d['y'], 'lon': d['x'], 'how': 'name:' + (d['en'] or d['n'])}
    locs = [d for d in divs if d['subtype'] in ('locality', 'localadmin')]
    dist = lambda d: haversine(t['lat'], t['lon'], d['y'], d['x'])
    main = {norm(t['name']), strip_generic(norm(t['name']))}
    # GHSL sometimes writes "Rotterdam [The Hague]": the part outside brackets is the main name.
    main |= {norm(re.sub(r'\[.*?\]', '', t['name']))}
    hit = [d for d in locs if keys(d) & main and dist(d) < 60000]
    if hit:
        return best(hit)
    alts = {k for x in t.get('names', []) for k in (norm(x), strip_generic(norm(x)))}
    hit = [d for d in locs if keys(d) & alts and dist(d) < 25000]
    if hit:
        hit.sort(key=lambda d: (-(d['pop'] or 0), dist(d)))
        d = hit[0]
        return {'lat': d['y'], 'lon': d['x'], 'how': 'alt:' + (d['en'] or d['n'])}
    big = sorted([d for d in locs if d['pop'] and dist(d) < 15000], key=lambda d: -d['pop'])
    if big and big[0]['pop'] > 0.2 * (t.get('pop') or 0):
        d = big[0]
        return {'lat': d['y'], 'lon': d['x'], 'how': 'largest:' + (d['en'] or d['n'])}
    return {'lat': t['lat'], 'lon': t['lon'], 'how': 'ghsl-centroid'}

def transit(box, q):
    """Transit stops (OSM via Overture base/infrastructure) and mapped crossings."""
    infra = q('infrastructure', f"""
      SELECT round((bbox.xmin + bbox.xmax) / 2, 5), round((bbox.ymin + bbox.ymax) / 2, 5), class,
             source_tags['railway'], source_tags['tram'], source_tags['light_rail'], source_tags['station'],
             source_tags['bus'], source_tags['highway'], source_tags['ferry']
      FROM {src('base', 'infrastructure')}
      WHERE {inside(box['pois'])} AND ((subtype = 'transit' AND class IN
          ('bus_stop','railway_station','railway_halt','subway_station','stop_position','platform','ferry_terminal'))
        OR (subtype = 'transportation' AND class = 'crossing'))""")
    s, w, n, e = box['net']
    stops, crossings = [], []
    for x, y, cls, railway, tram, light, station, bus, highway, ferry in infra:
        if cls == 'crossing':
            if s <= y <= n and w <= x <= e:
                crossings.append([x, y])
        elif cls == 'bus_stop' or (cls == 'platform' and (bus == 'yes' or highway == 'bus_stop')):
            stops.append([x, y, 'bus'])
        elif cls == 'ferry_terminal' or (cls == 'platform' and ferry == 'yes'):
            stops.append([x, y, 'ferry'])
        elif cls == 'subway_station' or station == 'subway':
            stops.append([x, y, 'metro'])
        elif cls in ('railway_station', 'railway_halt'):
            stops.append([x, y, 'tram' if station == 'light_rail' else 'rail'])
        elif cls in ('stop_position', 'platform') and (railway == 'tram_stop' or tram == 'yes' or light == 'yes'):
            stops.append([x, y, 'tram'])
    return stops, crossings

HOOD_TYPES = "('locality','localadmin','borough','macrohood','neighborhood','microhood')"
WALK = "('primary','secondary','tertiary','unclassified','residential','living_street','pedestrian','footway','path','steps','service')"

def extract(t):
    timings = {}
    def q(name, sql):
        t0 = time.time()
        rows = con.execute(sql).fetchall()
        timings[name] = round(time.time() - t0, 1)
        return rows

    # Divisions around the GHSL centroid: city centre + neighbourhood points.
    around = pad((t['lat'], t['lon'], t['lat'], t['lon']), 60000)
    divs = [dict(zip(['id', 'n', 'en', 'subtype', 'class', 'pop', 'x', 'y'], r)) for r in q('divisions', f"""
      SELECT id, names.primary, names.common['en'], subtype, class, population, ST_X(geometry), ST_Y(geometry)
      FROM {src('divisions', 'division')} WHERE {inside(around)} AND subtype IN {HOOD_TYPES}""")]
    centre = pick_centre(t, divs)

    # Analysis bbox: the urban-centre polygon clipped to RADIUS around the centre.
    circle = pad((centre['lat'], centre['lon'], centre['lat'], centre['lon']), RADIUS)
    xs = [p[0] for poly in t['polygon'] for ring in poly for p in ring]
    ys = [p[1] for poly in t['polygon'] for ring in poly for p in ring]
    area = (max(circle[0], min(ys)), max(circle[1], min(xs)), min(circle[2], max(ys)), min(circle[3], max(xs)))
    if area[0] >= area[2] or area[1] >= area[3]:
        area = pad((centre['lat'], centre['lon'], centre['lat'], centre['lon']), 2000)
    box = {k: pad(area, m) for k, m in MARGIN.items()}

    places = q('places', f"""
      SELECT round(bbox.xmin, 5), round(bbox.ymin, 5), basic_category FROM {src('places', 'place')}
      WHERE {inside(box['pois'])} AND confidence >= 0.5 AND basic_category IN ({IN_LIST})
        AND (operating_status IS NULL OR operating_status = 'open')""")
    places = [[x, y, CAT_OF[c]] for x, y, c in places]

    stops, crossings = transit(box, q)

    parks = q('parks', f"""
      SELECT ST_AsGeoJSON(ST_SimplifyPreserveTopology(geometry, 0.00003)), names.primary FROM {src('base', 'land_use')}
      WHERE {touches(box['pois'])} AND subtype = 'park' AND class IN ('park', 'dog_park')""")
    parks = [{'name': n or '', 'rings': geojson_rings(g)} for g, n in parks]

    t0 = time.time()
    con.execute(f"""
      CREATE OR REPLACE TEMP TABLE seg AS
      SELECT class, subclass, connectors, geometry, bbox,
        coalesce(list_bool_or(list_transform(road_flags, f -> list_contains(f.values, 'is_link'))), false) OR coalesce(subclass, '') = 'link' AS is_link,
        coalesce(list_bool_or(list_transform(road_flags, f -> list_contains(f.values, 'is_tunnel') AND f.between IS NULL)), false) AS is_tunnel
      FROM {src('transportation', 'segment')}
      WHERE {touches(box['geo'])} AND subtype = 'road' AND (class IN {WALK} OR class IN ('motorway', 'trunk'))""")
    timings['segments'] = round(time.time() - t0, 1)

    s, w, n, e = box['net']
    inter = q('inter', f"""
      WITH walk AS (
        SELECT connectors, geometry FROM seg
        WHERE class IN {WALK} AND NOT is_link
          AND coalesce(subclass, '') NOT IN ('sidewalk', 'crosswalk', 'parking_aisle', 'driveway', 'cycle_crossing')
          AND (class <> 'service' OR subclass = 'alley')),
      links AS (SELECT unnest(connectors) AS c, geometry FROM walk),
      deg AS (
        SELECT c.connector_id AS id,
               sum(CASE WHEN c.at <= 1e-6 OR c.at >= 1 - 1e-6 THEN 1 ELSE 2 END) AS d,
               any_value(ST_LineInterpolatePoint(geometry, c.at)) AS pt
        FROM links GROUP BY 1)
      SELECT round(ST_X(pt), 5) x, round(ST_Y(pt), 5) y FROM deg
      WHERE d >= 3 AND ST_X(pt) BETWEEN {w} AND {e} AND ST_Y(pt) BETWEEN {s} AND {n}""")

    ped = q('ped', f"""
      SELECT round(ST_X(ST_Centroid(geometry)), 5), round(ST_Y(ST_Centroid(geometry)), 5),
             round(ST_Length_Spheroid(ST_FlipCoordinates(geometry)), 1)
      FROM seg WHERE class IN ('pedestrian', 'living_street', 'footway', 'steps')
        AND coalesce(subclass, '') NOT IN ('sidewalk', 'crosswalk') AND {inside(box['net'])}""")

    hw = q('highways', f"""
      SELECT class, ST_AsGeoJSON(ST_SimplifyPreserveTopology(geometry, 0.00005)) FROM seg
      WHERE class IN ('motorway', 'trunk') AND NOT is_link AND NOT is_tunnel""")
    motorways = [r for c, g in hw if c == 'motorway' for r in geojson_rings(g)]
    trunks = [r for c, g in hw if c == 'trunk' for r in geojson_rings(g)]

    areas = q('hood_areas', f"""
      SELECT division_id, subtype, ST_AsGeoJSON(ST_SimplifyPreserveTopology(geometry, 0.0001)) FROM {src('divisions', 'division_area')}
      WHERE {touches(area)} AND subtype IN {HOOD_TYPES} AND is_land""")
    by_div = {}
    for did, sub, g in areas:
        by_div.setdefault(did, []).extend(geojson_rings(g))
    s, w, n, e = pad(area, 1500)
    hoods = [{'id': d['id'], 'name': d['n'], 'en': d['en'], 'type': d['subtype'], 'class': d['class'], 'pop': d['pop'],
              'x': r5(d['x']), 'y': r5(d['y']), 'rings': by_div.get(d['id'])}
             for d in divs if (w <= d['x'] <= e and s <= d['y'] <= n) or d['id'] in by_div]

    return {
        'id': t['id'], 'name': t['name'], 'iso3': t['iso3'], 'release': RELEASE, 'radius': RADIUS,
        'centre': centre, 'area': area, 'boxes': box, 'timings': timings,
        'places': places, 'stops': stops, 'crossings': crossings, 'stopsVersion': 2,
        'parks': parks, 'inter': [list(r) for r in inter], 'ped': [list(r) for r in ped],
        'motorways': motorways, 'trunks': trunks, 'hoods': hoods,
    }

targets = json.load(open(os.path.join(ROOT, 'build', 'targets.json'), encoding='utf-8'))

if '--refresh-stops' in sys.argv:
    # Re-run only the transit query for cities extracted before a tagging fix.
    for i, t in enumerate(targets):
        path = os.path.join(OUT, f"{t['id']}.json.gz")
        if i % shards != shard or not os.path.exists(path):
            continue
        with gzip.open(path, 'rt', encoding='utf-8') as f:
            data = json.load(f)
        if data.get('stopsVersion') == 2:
            continue
        data['stops'], data['crossings'] = transit(data['boxes'], lambda name, sql: con.execute(sql).fetchall())
        data['stopsVersion'] = 2
        with gzip.open(path + '.tmp', 'wt', encoding='utf-8') as f:
            json.dump(data, f, separators=(',', ':'))
        os.replace(path + '.tmp', path)
        print('refreshed', t['name'], len(data['stops']), flush=True)
    sys.exit(0)
done = 0
t_start = time.time()
for i, t in enumerate(targets):
    if i % shards != shard:
        continue
    if done >= limit:
        break
    if only is not None and t['id'] not in only:
        continue
    if only is None and not (tier_lo <= t['tier'] <= tier_hi):
        continue
    path = os.path.join(OUT, f"{t['id']}.json.gz")
    if os.path.exists(path):
        continue
    t0 = time.time()
    try:
        data = extract(t)
    except Exception as err:  # keep going; a rerun retries failures
        print(f"x {t['name']} ({t['iso3']}): {err}", flush=True)
        continue
    with gzip.open(path + '.tmp', 'wt', encoding='utf-8') as f:
        json.dump(data, f, separators=(',', ':'))
    os.replace(path + '.tmp', path)
    done += 1
    print(f"ok {t['name']} ({t['iso3']}) t{t['tier']} centre={data['centre']['how']} places={len(data['places'])} "
          f"inter={len(data['inter'])} ped={len(data['ped'])} cross={len(data['crossings'])} stops={len(data['stops'])} parks={len(data['parks'])} mw={len(data['motorways'])} hoods={len(data['hoods'])} "
          f"{time.time() - t0:.0f}s {data['timings']} [{done} done, {(time.time() - t_start) / 60:.0f} min]", flush=True)

#!/usr/bin/env python3
"""
Extract Ukrainian streets that carry a former name, with the settlement they lie in, from an
OpenStreetMap dump (LEXAI-2316). Input data © OpenStreetMap contributors, ODbL 1.0
(https://www.openstreetmap.org/copyright); the outputs are a derivative database under ODbL.

    python3 -I extract_osm_streets.py /data/ukraine-latest.osm.pbf /data/out

Reads a Geofabrik extract once with pyosmium (node locations in a sparse in-memory index,
multipolygons assembled by osmium) and writes, without any interpretation of names:

  areas.ndjson     every place=* area and every boundary=administrative area of admin_level 4..9:
                   {id, tags, km2, pc5: {postcode: n}} — pc5 counts the addr:postcode values of
                   objects inside the area (areas of admin_level >= 7 and place areas only)
  places.ndjson    place=* nodes: {id, tags, lon, lat, areas: [area ids containing it]}
  streets.ndjson   named highway ways with at least one former-name tag:
                   {id, tags, lon, lat, areas: [...], near: [[place node id, metres], ...]}
                   lon/lat is the middle vertex of the way; near lists place nodes within 5 km
  current-names.ndjson  every named highway way: {n: name:uk or name, areas: [...], near: [...]}
  tag-stats.json   counts of name-like tag keys on named highway ways (to see which tags carry
                   renamings)

Settlement keys, street-name parsing and the choice of a settlement are left to
src/scripts/import-osm-street-renamings.ts, which reads these files.

Runs in a throwaway container (python:3.12-slim + `pip install osmium shapely`); needs ~6 GB RAM
for the Ukraine extract.
"""
import json
import math
import os
import re
import sys
import time
from collections import Counter, defaultdict

import osmium
import shapely
from shapely import wkb as shp_wkb

RENAME_KEY = re.compile(r'^(?:old_name(?::.*)?|was:name(?::.*)?|not:name(?::.*)?|name:(?:1[89]|20)\d\d.*|old_official_name.*|old_alt_name.*)$')
NAME_LIKE = re.compile(r'(?:^|:)(?:name|old_name|alt_name|official_name|loc_name|short_name)(?::|$)|name:etymology')
KEEP_AREA_TAGS = re.compile(r'^(?:name|name:uk|name:ru|name:prefix|name:prefix:uk|place|boundary|admin_level|koatuu|katotth|'
                            r'addr:postcode|postal_code|population|ISO3166-2|official_name|official_name:uk|type|old_name|old_name:uk|designation)$')
SETTLEMENT_PLACES = {'city', 'town', 'village', 'hamlet', 'isolated_dwelling', 'suburb', 'quarter', 'neighbourhood', 'locality'}
POSTCODE = re.compile(r'^\d{5}$')


def log(msg):
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


def keep(tags, pattern):
    return {t.k: t.v for t in tags if pattern.match(t.k)}


def main(src, out_dir):
    t0 = time.time()
    os.makedirs(out_dir, exist_ok=True)
    wkbf = osmium.geom.WKBFactory()

    areas = {}          # id -> {tags, geom}
    places = []         # {id, tags, lon, lat}
    streets = []        # {id, tags, lon, lat}
    named = []          # (lon, lat, current name) of every named highway way
    postcodes = []      # (lon, lat, pc)
    tag_stats = Counter()
    n_highway_named = 0
    bad_geom = 0

    fp = (osmium.FileProcessor(src)
          .with_locations('sparse_mem_array')
          .with_areas(osmium.filter.KeyFilter('place', 'boundary'))
          .with_filter(osmium.filter.KeyFilter('highway', 'place', 'boundary', 'addr:postcode')))
    for o in fp:
        tags = o.tags
        if o.is_area():
            place = tags.get('place')
            admin = tags.get('admin_level')
            is_admin = tags.get('boundary') == 'administrative' and admin in ('4', '5', '6', '7', '8', '9')
            if not (place in SETTLEMENT_PLACES or is_admin):
                continue
            try:
                g = shp_wkb.loads(bytes.fromhex(wkbf.create_multipolygon(o)))
            except Exception:
                bad_geom += 1
                continue
            areas[o.id] = {'tags': keep(tags, KEEP_AREA_TAGS), 'geom': g}
            pc = tags.get('addr:postcode')
            if pc and POSTCODE.match(pc):
                c = g.representative_point()
                postcodes.append((c.x, c.y, pc))
            continue
        if o.is_node():
            pc = tags.get('addr:postcode')
            if pc and POSTCODE.match(pc) and o.location.valid():
                postcodes.append((o.location.lon, o.location.lat, pc))
            if tags.get('place') in SETTLEMENT_PLACES and o.location.valid():
                places.append({'id': o.id, 'tags': keep(tags, KEEP_AREA_TAGS), 'lon': o.location.lon, 'lat': o.location.lat})
            continue
        if o.is_way():
            nodes = o.nodes
            if len(nodes) < 2:
                continue
            pc = tags.get('addr:postcode')
            if pc and POSTCODE.match(pc) and 'highway' not in tags:
                loc = nodes[0].location
                if loc.valid():
                    postcodes.append((loc.lon, loc.lat, pc))
            if 'highway' in tags and ('name' in tags or 'name:uk' in tags):
                n_highway_named += 1
                mid = nodes[len(nodes) // 2].location
                if mid.valid():
                    named.append((mid.lon, mid.lat, tags.get('name:uk') or tags.get('name')))
                for t in tags:
                    if NAME_LIKE.search(t.k) or RENAME_KEY.match(t.k):
                        tag_stats[re.sub(r'\d{4}', 'YYYY', t.k)] += 1
                ren = keep(tags, RENAME_KEY)
                if ren:
                    if not mid.valid():
                        bad_geom += 1
                        continue
                    t = keep(tags, re.compile(r'^(?:name|name:uk|name:ru|highway)$'))
                    t.update(ren)
                    streets.append({'id': o.id, 'tags': t, 'lon': mid.lon, 'lat': mid.lat})
    log(f'read: {len(areas)} areas, {len(places)} place nodes, {n_highway_named} named highways, '
        f'{len(streets)} with a former name, {len(postcodes)} postcodes, {bad_geom} bad geometries; {time.time() - t0:.0f} s')

    # ---- spatial joins
    ids = list(areas.keys())
    geoms = [areas[i]['geom'] for i in ids]
    for g in geoms:
        shapely.prepare(g)
    tree = shapely.STRtree(geoms)

    def containing(xs, ys):
        pts = shapely.points(xs, ys)
        hits = tree.query(pts, predicate='within')  # [[point idx], [geom idx]]
        out = defaultdict(list)
        for pi, gi in zip(hits[0].tolist(), hits[1].tolist()):
            out[pi].append(ids[gi])
        return out

    local_area = {i for i in ids if 'place' in areas[i]['tags'] or areas[i]['tags'].get('admin_level') in ('7', '8', '9')}
    pc_hist = defaultdict(Counter)
    if postcodes:
        hits = containing([p[0] for p in postcodes], [p[1] for p in postcodes])
        for pi, area_ids in hits.items():
            for a in area_ids:
                if a in local_area:
                    pc_hist[a][postcodes[pi][2]] += 1
    log(f'postcodes joined: {len(pc_hist)} areas with postcodes; {time.time() - t0:.0f} s')

    with open(os.path.join(out_dir, 'areas.ndjson'), 'w') as f:
        for i in ids:
            g = areas[i]['geom']
            lat = g.centroid.y
            km2 = g.area * (111.32 ** 2) * math.cos(math.radians(lat))
            f.write(json.dumps({'id': i, 'tags': areas[i]['tags'], 'km2': round(km2, 4), 'pc5': dict(pc_hist.get(i, {}))}, ensure_ascii=False) + '\n')

    p_hits = containing([p['lon'] for p in places], [p['lat'] for p in places])
    with open(os.path.join(out_dir, 'places.ndjson'), 'w') as f:
        for k, p in enumerate(places):
            p['areas'] = p_hits.get(k, [])
            f.write(json.dumps(p, ensure_ascii=False) + '\n')

    s_hits = containing([s['lon'] for s in streets], [s['lat'] for s in streets])
    # nearest place nodes (fallback for streets outside every settlement polygon)
    p_pts = shapely.points([p['lon'] for p in places], [p['lat'] for p in places])
    p_tree = shapely.STRtree(p_pts)
    s_pts = shapely.points([s['lon'] for s in streets], [s['lat'] for s in streets])
    near = p_tree.query(s_pts, predicate='dwithin', distance=0.07)
    near_by = defaultdict(list)
    for si, pi in zip(near[0].tolist(), near[1].tolist()):
        s, p = streets[si], places[pi]
        dx = (p['lon'] - s['lon']) * 111320 * math.cos(math.radians(s['lat']))
        dy = (p['lat'] - s['lat']) * 110540
        d = math.hypot(dx, dy)
        if d <= 5000:
            near_by[si].append((places[pi]['id'], round(d)))
    with open(os.path.join(out_dir, 'streets.ndjson'), 'w') as f:
        for k, s in enumerate(streets):
            s['areas'] = s_hits.get(k, [])
            s['near'] = sorted(near_by.get(k, []), key=lambda x: x[1])[:5]
            f.write(json.dumps(s, ensure_ascii=False) + '\n')

    # current names of all named highways, per area / nearest place (the old name of one street can be
    # the current name of another: such renamings are not applied)
    n_hits = containing([x[0] for x in named], [x[1] for x in named])
    n_pts = shapely.points([x[0] for x in named], [x[1] for x in named])
    n_near = p_tree.query(n_pts, predicate='dwithin', distance=0.07)
    n_near_by = defaultdict(list)
    for si, pi in zip(n_near[0].tolist(), n_near[1].tolist()):
        x, p = named[si], places[pi]
        d = math.hypot((p['lon'] - x[0]) * 111320 * math.cos(math.radians(x[1])), (p['lat'] - x[1]) * 110540)
        if d <= 5000:
            n_near_by[si].append((p['id'], round(d)))
    with open(os.path.join(out_dir, 'current-names.ndjson'), 'w') as f:
        for k, x in enumerate(named):
            f.write(json.dumps({'n': x[2], 'areas': n_hits.get(k, []), 'near': sorted(n_near_by.get(k, []), key=lambda y: y[1])[:3]},
                               ensure_ascii=False) + '\n')
    log(f'current names: {len(named)} ways; {time.time() - t0:.0f} s')

    with open(os.path.join(out_dir, 'tag-stats.json'), 'w') as f:
        json.dump({'named_highways': n_highway_named, 'with_former_name': len(streets),
                   'keys': dict(tag_stats.most_common())}, f, ensure_ascii=False, indent=1)
    log(f'done: {len(streets)} streets, {sum(1 for k in range(len(streets)) if s_hits.get(k))} inside an area; {time.time() - t0:.0f} s')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])

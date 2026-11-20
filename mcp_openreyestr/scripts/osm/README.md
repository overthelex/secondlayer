# Street renamings from OpenStreetMap (LEXAI-2316)

Data © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)
(https://www.openstreetmap.org/copyright). The `street_renamings_scoped` rows with `source='osm'`
are a derivative database under ODbL. Wherever they are shown, credit «© OpenStreetMap contributors».
Do not commit the dump, the extract or the output CSVs.

Run it once a month (Geofabrik updates daily). Everything stays on the HDD of cthulhu, in
`/mnt/bulk_storage/opendata/osm/`. Do not put it on the NVMe. Nothing is installed on the host.

```bash
cd /mnt/bulk_storage/opendata/osm
curl -sS -L -o ukraine-latest.osm.pbf https://download.geofabrik.de/europe/ukraine-latest.osm.pbf   # ~0.9 GB

# pyosmium + shapely, once, into a directory on the HDD
docker run --rm -v $PWD/pydeps:/deps python:3.12-slim pip install -q --target /deps osmium shapely

# extract (~6 GB RAM); app/ holds a copy of extract_osm_streets.py
docker run --rm -e PYTHONPATH=/deps -v $PWD/pydeps:/deps:ro -v $PWD/app:/app:ro -v $PWD:/data -w /tmp \
  python:3.12-slim sh -c "apt-get update -qq && apt-get install -y -qq libexpat1 >/dev/null; \
  python3 -s -P /app/extract_osm_streets.py /data/ukraine-latest.osm.pbf /data/extract; chown -R $(id -u):$(id -g) /data/extract"

# rows: a dry run writes CSVs (rows, agreement with edr_history, a sample to check by hand)
npm run import:osm-street-renamings -- --dir /mnt/bulk_storage/opendata/osm/extract \
  --dry-run --out /mnt/bulk_storage/opendata/osm/out
# then without --dry-run: replaces the source='osm' rows in one transaction
```

The extractor writes only what OSM says (tags, the areas that contain each street, the nearest
place nodes). The script `src/scripts/import-osm-street-renamings.ts` makes the settlement keys and
reads the names. The logic lives in `src/services/graph-norm/osm-street-renamings.ts` and has tests.

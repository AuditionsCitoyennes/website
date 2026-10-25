-- Overture Maps divisions → one local parquet of the land polygons the site
-- would tile (phase 0 of docs/map-roadmap-2026-10-25.md), plus the counts the
-- roadmap's "deepest available level per country" decision needs.
--
-- Run by build-boundaries.sh, which sets the variables:
--   release  the Overture release, e.g. '2026-10-21.0'
--   out      the output directory (its raw/ subfolder receives the files)
--
-- One pass over the division_area theme (~4.6 GB of parquet on S3, read with
-- httpfs; only the needed columns are decoded). Subtypes kept: country,
-- dependency (Greenland, Hong Kong…: the top level of their own code),
-- region, county, localadmin, locality. Land polygons only, and ONE polygon
-- per division: the land-only variant when it exists, else the land +
-- territorial-waters one (most regions and every locality come in that form
-- only). The parent comes from the division (point) table.

INSTALL httpfs;
LOAD httpfs;
INSTALL spatial;
LOAD spatial;
SET s3_region = 'us-west-2';
SET geometry_always_xy = true;
SET preserve_insertion_order = false;

-- The parent of every division (and its population, kept for later ranking).
CREATE OR REPLACE TABLE parents AS
SELECT id, parent_division_id AS parent, population
FROM read_parquet(
  's3://overturemaps-us-west-2/release/' || getvariable('release') || '/theme=divisions/type=division/*.parquet'
);

CREATE OR REPLACE TABLE areas AS
SELECT
  a.division_id AS id,
  a.names.primary AS name,
  a.subtype AS level,
  p.parent,
  a.country,
  a.region AS iso_region,
  p.population,
  a.geometry
FROM read_parquet(
  's3://overturemaps-us-west-2/release/' || getvariable('release') || '/theme=divisions/type=division_area/*.parquet'
) a
LEFT JOIN parents p ON p.id = a.division_id
WHERE a.subtype IN ('country', 'dependency', 'region', 'county', 'localadmin', 'locality')
  AND a.is_land
QUALIFY row_number() OVER (PARTITION BY a.division_id ORDER BY a.is_territorial) = 1;

-- Ordered by level then country so a per-country export touches few row groups.
COPY (SELECT * FROM areas ORDER BY level, country)
TO (getvariable('out') || '/raw/overture-areas.parquet')
WITH (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 20000);

-- ---- Counts ------------------------------------------------------------------

COPY (
  SELECT level,
         count(*) AS features,
         sum(ST_NPoints(geometry)) AS vertices,
         round(avg(ST_NPoints(geometry))) AS vertices_avg,
         max(ST_NPoints(geometry)) AS vertices_max,
         sum(octet_length(ST_AsWKB(geometry))) AS wkb_bytes
  FROM areas
  GROUP BY level
  ORDER BY CASE level
    WHEN 'country' THEN 0 WHEN 'dependency' THEN 1 WHEN 'region' THEN 2
    WHEN 'county' THEN 3 WHEN 'localadmin' THEN 4 ELSE 5 END
) TO (getvariable('out') || '/raw/features-per-level.csv') WITH (FORMAT CSV, HEADER);

-- Per country code: how many polygons each level has, and the deepest level
-- with at least one. A country's own row (level country or dependency) gives
-- its name.
COPY (
  WITH per AS (
    SELECT country,
           count(*) FILTER (WHERE level IN ('country', 'dependency')) AS n_country,
           count(*) FILTER (WHERE level = 'region') AS n_region,
           count(*) FILTER (WHERE level = 'county') AS n_county,
           count(*) FILTER (WHERE level = 'localadmin') AS n_localadmin,
           count(*) FILTER (WHERE level = 'locality') AS n_locality
    FROM areas
    WHERE country IS NOT NULL
    GROUP BY country
  ),
  named AS (
    SELECT country, any_value(name) AS name, any_value(level) AS top_level
    FROM areas
    WHERE level IN ('country', 'dependency')
    GROUP BY country
  )
  SELECT per.country, named.name, named.top_level,
         n_country, n_region, n_county, n_localadmin, n_locality,
         CASE
           WHEN n_locality > 0 THEN 'locality'
           WHEN n_localadmin > 0 THEN 'localadmin'
           WHEN n_county > 0 THEN 'county'
           WHEN n_region > 0 THEN 'region'
           ELSE 'country'
         END AS deepest
  FROM per
  LEFT JOIN named USING (country)
  ORDER BY per.country
) TO (getvariable('out') || '/raw/depth-per-country.csv') WITH (FORMAT CSV, HEADER);

-- The three largest polygons of each level, by vertex count.
COPY (
  SELECT level, id, name, country,
         ST_NPoints(geometry) AS vertices,
         octet_length(ST_AsWKB(geometry)) AS wkb_bytes,
         ST_GeometryType(geometry) AS type
  FROM areas
  QUALIFY row_number() OVER (PARTITION BY level ORDER BY ST_NPoints(geometry) DESC) <= 3
  ORDER BY level, vertices DESC
) TO (getvariable('out') || '/raw/largest-features.csv') WITH (FORMAT CSV, HEADER);

-- The country codes present (one chunk each for the deeper levels).
COPY (
  SELECT DISTINCT country FROM areas
  WHERE country IS NOT NULL AND level IN ('county', 'localadmin', 'locality')
  ORDER BY country
) TO (getvariable('out') || '/raw/countries.csv') WITH (FORMAT CSV, HEADER false);

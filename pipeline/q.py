import duckdb, sys
con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'; SET enable_progress_bar=false;")
R = 's3://overturemaps-us-west-2/release/2026-09-23.1/'
print(con.execute(f"""SELECT class, source_tags['railway'] r, source_tags['tram'] t, source_tags['public_transport'] pt, source_tags['ferry'] f, source_tags['highway'] h, count(*)
 FROM read_parquet('{R}theme=base/type=infrastructure/*') WHERE bbox.xmin BETWEEN 4.86 AND 4.92 AND bbox.ymin BETWEEN 52.35 AND 52.38 AND subtype='transit' AND class NOT LIKE '%parking%'
 GROUP BY ALL ORDER BY 7 DESC LIMIT 25""").fetchall())
print(con.execute(f"""SELECT class, source_tags['public_transport'] pt, source_tags['ferry'] f, source_tags['amenity'] a, count(*)
 FROM read_parquet('{R}theme=base/type=infrastructure/*') WHERE bbox.xmin BETWEEN 12.31 AND 12.36 AND bbox.ymin BETWEEN 45.42 AND 45.45 AND subtype='transit' AND class NOT LIKE '%parking%'
 GROUP BY ALL ORDER BY 5 DESC LIMIT 15""").fetchall())

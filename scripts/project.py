"""Project high-dimensional embeddings to 2D/3D coordinates (x, y, z).

Pipeline: IncrementalPCA (two-pass, memory-safe) -> UMAP -> batched write-back.

Usage:
    export DATABASE_URL=postgres://postgres:postgres@localhost:5432/vectorview
    python scripts/project.py --table items

For 10M+ rows consider the GPU path (cuvs / RAPIDS cuML UMAP) instead.
"""

import argparse
import os
import sys
import time

import numpy as np
import psycopg
from pgvector.psycopg import register_vector
from sklearn.decomposition import IncrementalPCA


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def count_rows(conn, table: str, embedding_col: str) -> int:
    with conn.cursor() as cur:
        cur.execute(
            f'SELECT count(*) FROM "{table}" WHERE "{embedding_col}" IS NOT NULL'
        )
        return cur.fetchone()[0]


def iter_batches(conn, table: str, id_col: str, embedding_col: str, batch_size: int):
    """Yield (ids, embeddings) batches via a server-side cursor."""
    with conn.cursor(name="emb_reader") as cur:
        cur.itersize = batch_size
        cur.execute(
            f'SELECT "{id_col}", "{embedding_col}" FROM "{table}" '
            f'WHERE "{embedding_col}" IS NOT NULL ORDER BY "{id_col}"'
        )
        while True:
            rows = cur.fetchmany(batch_size)
            if not rows:
                break
            ids = np.array([r[0] for r in rows], dtype=np.int64)
            vecs = np.array(
                [
                    np.asarray(
                        v.to_numpy() if hasattr(v, "to_numpy") else v,
                        dtype=np.float32,
                    )
                    for v in (r[1] for r in rows)
                ]
            )
            yield ids, vecs


def fit_pca(conn, args, n_rows: int) -> IncrementalPCA:
    n_components = min(args.pca_dims, n_rows)
    pca = IncrementalPCA(n_components=n_components, batch_size=args.batch_size)
    done = 0
    for _ids, vecs in iter_batches(
        conn, args.table, args.id_column, args.embedding_column, args.batch_size
    ):
        pca.partial_fit(vecs)
        done += len(vecs)
        log(f"PCA partial_fit {done}/{n_rows}")
    return pca


def transform_pca(conn, args, pca: IncrementalPCA, n_rows: int):
    ids_all = np.empty(n_rows, dtype=np.int64)
    reduced_all = np.empty((n_rows, pca.n_components_), dtype=np.float32)
    offset = 0
    for ids, vecs in iter_batches(
        conn, args.table, args.id_column, args.embedding_column, args.batch_size
    ):
        n = len(ids)
        ids_all[offset : offset + n] = ids
        reduced_all[offset : offset + n] = pca.transform(vecs)
        offset += n
        log(f"PCA transform {offset}/{n_rows}")
    return ids_all, reduced_all


def run_umap(reduced: np.ndarray, args) -> np.ndarray:
    import umap

    n = len(reduced)
    reducer = umap.UMAP(
        n_components=args.components,
        metric="cosine",
        n_neighbors=15,
        min_dist=0.1,
        low_memory=True,
        verbose=True,
    )
    if n <= args.fit_max:
        log(f"UMAP fit on all {n} rows")
        return reducer.fit_transform(reduced)

    # Large datasets: fit on a random subset, then transform the rest in batches.
    idx = np.random.default_rng(42).choice(n, size=args.fit_max, replace=False)
    log(f"UMAP fit on {args.fit_max} sampled rows (of {n})")
    reducer.fit(reduced[idx])
    out = np.empty((n, args.components), dtype=np.float32)
    for start in range(0, n, args.batch_size):
        end = min(start + args.batch_size, n)
        out[start:end] = reducer.transform(reduced[start:end])
        log(f"UMAP transform {end}/{n}")
    return out


def write_back(conn, table: str, id_col: str, ids: np.ndarray, coords: np.ndarray) -> None:
    log("Writing coordinates back to Postgres")
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TEMP TABLE projection_writeback "
            "(id bigint PRIMARY KEY, x float8, y float8, z float8) ON COMMIT DROP"
        )
        with cur.copy("COPY projection_writeback (id, x, y, z) FROM STDIN") as copy:
            z_col = coords[:, 2] if coords.shape[1] >= 3 else np.zeros(len(ids))
            for i in range(len(ids)):
                copy.write_row((int(ids[i]), float(coords[i, 0]), float(coords[i, 1]), float(z_col[i])))
        cur.execute(
            f'UPDATE "{table}" t SET x = w.x, y = w.y, z = w.z '
            f"FROM projection_writeback w "
            f'WHERE t."{id_col}" = w.id'
        )
    conn.commit()
    log(f"Updated {len(ids)} rows")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--table", default=os.environ.get("PG_TABLE", "items"))
    parser.add_argument("--id-column", default=os.environ.get("PG_ID_COLUMN", "id"))
    parser.add_argument(
        "--embedding-column", default=os.environ.get("PG_EMBEDDING_COLUMN", "embedding")
    )
    parser.add_argument("--batch-size", type=int, default=50_000)
    parser.add_argument("--pca-dims", type=int, default=50)
    parser.add_argument(
        "--components",
        type=int,
        default=3,
        choices=(2, 3),
        help="3 writes x/y/z, 2 writes x/y with z=0",
    )
    parser.add_argument(
        "--fit-max",
        type=int,
        default=500_000,
        help="max rows used to fit UMAP before switching to fit+transform",
    )
    args = parser.parse_args()

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL is not set")

    with psycopg.connect(dsn) as conn:
        register_vector(conn)
        n_rows = count_rows(conn, args.table, args.embedding_column)
        log(f"{n_rows} embedded rows in {args.table}")
        if n_rows == 0:
            sys.exit("No embeddings found")

        pca = fit_pca(conn, args, n_rows)
        ids, reduced = transform_pca(conn, args, pca, n_rows)

        coords = run_umap(reduced, args)
        write_back(conn, args.table, args.id_column, ids, coords)

    log("Done")


if __name__ == "__main__":
    main()

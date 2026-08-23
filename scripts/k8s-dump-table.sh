#!/usr/bin/env bash
# Dump selected columns from a table via a throwaway pod (in-cluster = fast).
# Meant for CloudNativePG: talk to the ClusterIP/pooler, then kubectl cp the file
# down. Physical CNPG backups / volume snapshots cannot dump one table.
#
#   scripts/k8s-dump-table.sh \
#     -n database \
#     --service database-cluster-pooler-ro \
#     --secret database-cluster-app \
#     --table public.Creator \
#     --id id \
#     --embedding persona_embedding \
#     --cluster category \
#     --label name \
#     -o dumps/creator.csv.gz
set -euo pipefail

NAMESPACE=""
SERVICE=""
SECRET=""
TABLE=""
ID_COL="id"
EMB_COL=""
CLUSTER_COL=""
LABEL_COL=""
OUT=""
IMAGE="${VV_DUMP_IMAGE:-postgres:17-alpine}"
KEEP_POD=0

usage() {
  sed -n '2,20p' "$0"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--namespace) NAMESPACE="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --secret) SECRET="$2"; shift 2 ;;
    --table) TABLE="$2"; shift 2 ;;
    --id) ID_COL="$2"; shift 2 ;;
    --embedding) EMB_COL="$2"; shift 2 ;;
    --cluster) CLUSTER_COL="$2"; shift 2 ;;
    --label) LABEL_COL="$2"; shift 2 ;;
    -o|--out) OUT="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --keep-pod) KEEP_POD=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown flag: $1" >&2; usage ;;
  esac
done

[[ -n "$NAMESPACE" && -n "$SERVICE" && -n "$SECRET" && -n "$TABLE" && -n "$EMB_COL" && -n "$OUT" ]] || usage

quote_ident() {
  local raw="$1"
  printf '"%s"' "${raw//\"/\"\"}"
}

SCHEMA="public"
REL="$TABLE"
if [[ "$TABLE" == *.* ]]; then
  SCHEMA="${TABLE%%.*}"
  REL="${TABLE#*.}"
fi
Q_SCHEMA="$(quote_ident "$SCHEMA")"
Q_REL="$(quote_ident "$REL")"
Q_ID="$(quote_ident "$ID_COL")"
Q_EMB="$(quote_ident "$EMB_COL")"

CLUSTER_SQL="''::text"
if [[ -n "$CLUSTER_COL" ]]; then
  CLUSTER_SQL="$(quote_ident "$CLUSTER_COL")::text"
fi
LABEL_SQL="''::text"
if [[ -n "$LABEL_COL" ]]; then
  LABEL_SQL="$(quote_ident "$LABEL_COL")::text"
fi

HOST="${SERVICE}.${NAMESPACE}.svc"
POD="vectorview-dump-$(date +%s)"
REMOTE="/dump/table.csv.gz"

COPY_SQL=$(cat <<SQL
COPY (
  SELECT
    ${Q_ID}::text AS source_id,
    ${Q_EMB}::text AS emb,
    COALESCE(${CLUSTER_SQL}, '') AS cluster,
    COALESCE(${LABEL_SQL}, '') AS label
  FROM ${Q_SCHEMA}.${Q_REL}
  WHERE ${Q_EMB} IS NOT NULL
) TO STDOUT WITH (FORMAT csv, HEADER true)
SQL
)

mkdir -p "$(dirname "$OUT")"

cleanup() {
  if [[ "$KEEP_POD" -eq 0 ]]; then
    kubectl delete pod -n "$NAMESPACE" "$POD" --wait=false >/dev/null 2>&1 || true
  else
    echo "Pod kept: kubectl -n $NAMESPACE exec -it $POD -- sh" >&2
  fi
}
trap cleanup EXIT

echo "Creating dump pod $POD in $NAMESPACE (image $IMAGE)" >&2
kubectl apply -n "$NAMESPACE" -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: $POD
  labels:
    app: vectorview-dump
spec:
  restartPolicy: Never
  containers:
    - name: dump
      image: $IMAGE
      command: ["sleep", "7200"]
      volumeMounts:
        - name: dump
          mountPath: /dump
  volumes:
    - name: dump
      emptyDir: {}
YAML

kubectl wait -n "$NAMESPACE" --for=condition=Ready "pod/$POD" --timeout=180s >/dev/null

echo "Dumping $Q_SCHEMA.$Q_REL ($ID_COL, $EMB_COL${CLUSTER_COL:+, $CLUSTER_COL}${LABEL_COL:+, $LABEL_COL})" >&2
echo "Source: $HOST  (in-cluster)" >&2

# CNPG *-app secret: username / password / dbname (uri is optional).
USER_B64="$(kubectl get secret -n "$NAMESPACE" "$SECRET" -o jsonpath='{.data.username}')"
PASS_B64="$(kubectl get secret -n "$NAMESPACE" "$SECRET" -o jsonpath='{.data.password}')"
DB_B64="$(kubectl get secret -n "$NAMESPACE" "$SECRET" -o jsonpath='{.data.dbname}')"
PGUSER="$(printf '%s' "$USER_B64" | base64 -d)"
PGPASSWORD="$(printf '%s' "$PASS_B64" | base64 -d)"
PGDATABASE="$(printf '%s' "$DB_B64" | base64 -d)"

SQL_FILE="$(mktemp)"
printf '%s\n' "$COPY_SQL" > "$SQL_FILE"
kubectl cp "$SQL_FILE" "$NAMESPACE/$POD:/tmp/copy.sql"
rm -f "$SQL_FILE"

# Sequential scan + gzip stay in-cluster. Only the compressed file is copied out.
kubectl exec -n "$NAMESPACE" "$POD" -- \
  env PGHOST="$HOST" PGPORT=5432 PGUSER="$PGUSER" PGPASSWORD="$PGPASSWORD" PGDATABASE="$PGDATABASE" \
  bash -lc "set -euo pipefail; psql -v ON_ERROR_STOP=1 -f /tmp/copy.sql | gzip -1 > '$REMOTE'; ls -lh '$REMOTE'"

echo "Copying $REMOTE -> $OUT" >&2
kubectl cp "$NAMESPACE/$POD:$REMOTE" "$OUT"
ls -lh "$OUT" >&2
echo "Done. Load with: pnpm db:load-dump $OUT" >&2

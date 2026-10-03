#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt}"
BACKUP_DIR="${BACKUP_DIR:-${APP_DIR}/backups}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env.production}"
[[ -f "${ENV_FILE}" ]] || ENV_FILE="${APP_DIR}/.env"
[[ -f "${ENV_FILE}" ]] || { echo "ERROR: production environment file not found" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a
[[ -n "${DATABASE_URL:-}" ]] || { echo "ERROR: DATABASE_URL is not configured" >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="${BACKUP_DIR}/${stamp}"
install -d -m 700 "${dest}"
printf '%s\n' "$(git -C "${APP_DIR}" rev-parse HEAD 2>/dev/null || echo unknown)" > "${dest}/commit.txt"

case "${DATABASE_URL}" in
  file:*)
    db="${DATABASE_URL#file:}"
    [[ "${db}" = /* ]] || db="${APP_DIR}/${db#./}"
    db="$(readlink -f "${db}")"
    [[ -f "${db}" && -s "${db}" ]] || { echo "ERROR: active SQLite database is missing or empty" >&2; exit 1; }
    [[ "$(sqlite3 "${db}" 'PRAGMA integrity_check;')" == "ok" ]] || { echo "ERROR: SQLite integrity check failed" >&2; exit 1; }
    sqlite3 "${db}" ".backup '${dest}/database.sqlite'"
    [[ -s "${dest}/database.sqlite" ]] || { echo "ERROR: SQLite backup verification failed" >&2; exit 1; }
    sqlite3 "${dest}/database.sqlite" 'PRAGMA integrity_check;' | grep -qx ok
    ;;
  mysql://*|mariadb://*)
    command -v mysqldump >/dev/null || { echo "ERROR: mysqldump is unavailable" >&2; exit 1; }
    node -e '
      const u=new URL(process.env.DATABASE_URL);
      for (const [k,v] of Object.entries({host:u.hostname,port:u.port||"3306",user:decodeURIComponent(u.username),pass:decodeURIComponent(u.password),name:u.pathname.slice(1)}))
        process.stdout.write(`${k}=${JSON.stringify(v)}\n`)' > "${dest}/db.env"
    # shellcheck disable=SC1090
    source "${dest}/db.env"
    MYSQL_PWD="${pass}" mysqldump --single-transaction --routines --triggers \
      -h "${host}" -P "${port}" -u "${user}" "${name}" | gzip -9 > "${dest}/database.sql.gz"
    gzip -t "${dest}/database.sql.gz"
    [[ -s "${dest}/database.sql.gz" ]] || { echo "ERROR: database dump is empty" >&2; exit 1; }
    rm -f "${dest}/db.env"
    ;;
  *) echo "ERROR: unsupported production database provider" >&2; exit 1 ;;
esac

# Preserve application-owned storage when present. This archive never replaces live files.
storage_paths=()
for candidate in storage data public/uploads; do
  [[ -d "${APP_DIR}/${candidate}" ]] && storage_paths+=("${candidate}")
done
if (( ${#storage_paths[@]} > 0 )); then
  tar -C "${APP_DIR}" -czf "${dest}/application-storage.tar.gz" "${storage_paths[@]}"
  tar -tzf "${dest}/application-storage.tar.gz" >/dev/null
fi

printf '{"created_at":"%s","commit":"%s","database_backup_verified":true,"storage_included":%s}\n' \
  "$(date -u +%FT%TZ)" "$(cat "${dest}/commit.txt")" \
  "$( (( ${#storage_paths[@]} > 0 )) && echo true || echo false )" > "${dest}/manifest.json"
chmod -R go-rwx "${dest}"

# Conservative retention: retain at least the 14 newest verified backups and
# only prune older verified sets after a newer verified set exists.
mapfile -t verified_backups < <(
  find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null |
    sort -rn | awk '{print $2}' | while read -r item; do
      [[ -s "${item}/manifest.json" ]] || continue
      [[ -s "${item}/database.sqlite" || -s "${item}/database.sql.gz" ]] || continue
      echo "${item}"
    done
)
if (( ${#verified_backups[@]} > 14 )); then
  for old in "${verified_backups[@]:14}"; do
    [[ "$(find "${old}" -maxdepth 0 -mtime +14 -print)" == "${old}" ]] || continue
    rm -rf --one-file-system "${old}"
  done
fi

echo "BACKUP_VERIFIED=${dest}"

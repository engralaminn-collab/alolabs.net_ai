#!/usr/bin/env bash
# ============================================================
# ALO Labs Agent Hub — SQLite to MariaDB Migration Script
# WARNING: This is a one-way migration. Back up everything first.
# Usage: sudo bash db-migrate-mariadb.sh [--dry-run]
# ============================================================

set -euo pipefail

# ── Configuration ────────────────────────────────────────────
APP_DIR="/opt/alolabs/agent-hub"
SQLITE_DB="${APP_DIR}/db/dev.db"
DRY_RUN=false

# ── Parse arguments ──────────────────────────────────────────
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        --help|-h)
            echo "Usage: sudo bash db-migrate-mariadb.sh [--dry-run]"
            echo ""
            echo "  --dry-run   Show what would be migrated without making changes"
            exit 0
            ;;
    esac
done

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: This script must be run as root."
    exit 1
fi

# ── Helpers ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[MIGRATE][$(date '+%Y-%m-%d %H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[MIGRATE][WARN]${NC} $*"; }
fail() { echo -e "${RED}[MIGRATE][ERROR]${NC} $*"; exit 1; }
ok()   { echo -e "  ${GREEN}✅${NC} $*"; }

# ── Pre-flight checks ────────────────────────────────────────
log "============================================================"
log "ALO Labs Agent Hub — SQLite → MariaDB Migration"
log "============================================================"

# Check SQLite DB exists
if [[ ! -f "${SQLITE_DB}" ]]; then
    # Try common alternative locations
    for alt in "${APP_DIR}/prisma/dev.db" "${APP_DIR}/db/data.db" "${APP_DIR}/data/dev.db"; do
        if [[ -f "${alt}" ]]; then
            SQLITE_DB="${alt}"
            warn "Found SQLite database at: ${SQLITE_DB}"
            break
        fi
    done
    if [[ ! -f "${SQLITE_DB}" ]]; then
        fail "SQLite database not found. Checked: ${SQLITE_DB}"
    fi
fi

# Check MariaDB is running
if ! mysqladmin ping -h 127.0.0.1 --silent 2>/dev/null; then
    fail "MariaDB is not running. Start it first: systemctl start mariadb"
fi

# Extract target DB credentials from .env
source "${APP_DIR}/.env" 2>/dev/null || true
if [[ -n "${DATABASE_URL:-}" ]]; then
    DB_USER=$(echo "${DATABASE_URL}" | sed -n 's|mysql://\([^:]*\):\([^@]*\)@\([^:]*\):\([0-9]*\)/\(.*\)|\1|p')
    DB_PASS=$(echo "${DATABASE_URL}" | sed -n 's|mysql://\([^:]*\):\([^@]*\)@\([^:]*\):\([0-9]*\)/\(.*\)|\2|p')
    DB_HOST=$(echo "${DATABASE_URL}" | sed -n 's|mysql://\([^:]*\):\([^@]*\)@\([^:]*\):\([0-9]*\)/\(.*\)|\3|p')
    DB_PORT=$(echo "${DATABASE_URL}" | sed -n 's|mysql://\([^:]*\):\([^@]*\)@\([^:]*\):\([0-9]*\)/\(.*\)|\4|p')
    DB_NAME=$(echo "${DATABASE_URL}" | sed -n 's|mysql://\([^:]*\):\([^@]*\)@\([^:]*\):\([0-9]*\)/\(.*\)|\5|p')
else
    DB_USER="alohub_user"
    DB_HOST="127.0.0.1"
    DB_PORT="3306"
    DB_NAME="alohub_production"
fi

log "Source:     SQLite  ${SQLITE_DB}"
log "Destination: MariaDB ${DB_HOST}:${DB_PORT}/${DB_NAME}"
log "Dry run:    ${DRY_RUN}"
log ""

# ── Check for sqlite3 tool ────────────────────────────────────
if ! command -v sqlite3 &>/dev/null; then
    log "Installing sqlite3..."
    apt-get install -y -qq sqlite3 2>/dev/null
    ok "sqlite3 installed"
fi

# ── Analyze SQLite database ───────────────────────────────────
log "Analyzing SQLite database..."
SQLITE_SIZE=$(du -h "${SQLITE_DB}" | cut -f1)
SQLITE_TABLES=$(sqlite3 "${SQLITE_DB}" ".tables" 2>/dev/null | tr ' ' '\n' | grep -v '^$' | sort)
TABLE_COUNT=$(echo "${SQLITE_TABLES}" | grep -c . || echo "0")

log "  SQLite size: ${SQLITE_SIZE}"
log "  Tables: ${TABLE_COUNT}"
echo ""

# Get row counts for each table
log "Table row counts:"
TOTAL_ROWS=0
for table in ${SQLITE_TABLES}; do
    ROWS=$(sqlite3 "${SQLITE_DB}" "SELECT COUNT(*) FROM \"${table}\";" 2>/dev/null || echo "0")
    TOTAL_ROWS=$(( TOTAL_ROWS + ROWS ))
    log "  ${table}: ${ROWS} rows"
done
log "  TOTAL: ${TOTAL_ROWS} rows"
echo ""

if [[ "${DRY_RUN}" == "true" ]]; then
    log "============================================================"
    log "DRY RUN COMPLETE — No data was migrated."
    log "============================================================"
    log "Run without --dry-run to perform the actual migration."
    exit 0
fi

# ── Confirmation ──────────────────────────────────────────────
echo -e "${RED}⚠️  WARNING: This will migrate ALL data from SQLite to MariaDB.${NC}"
echo -e "${RED}   Make sure you have a backup before proceeding.${NC}"
echo -e "${RED}   Source: ${SQLITE_DB} (${SQLITE_SIZE}, ${TOTAL_ROWS} rows)${NC}"
echo -e "${RED}   Target: ${DB_NAME} on ${DB_HOST}:${DB_PORT}${NC}"
read -rp "Type 'MIGRATE' to confirm: " CONFIRM
if [[ "${CONFIRM}" != "MIGRATE" ]]; then
    log "Migration cancelled."
    exit 0
fi

# ── Create safety backup ──────────────────────────────────────
log "Creating safety backup of SQLite database..."
BACKUP_DIR="${APP_DIR}/backups/pre_mariadb_migration_$(date '+%Y%m%d_%H%M%S')"
mkdir -p "${BACKUP_DIR}"
cp "${SQLITE_DB}" "${BACKUP_DIR}/"
cp "${APP_DIR}/.env" "${BACKUP_DIR}/.env.bak" 2>/dev/null || true
ok "Backup: ${BACKUP_DIR}"

# ── Step 1: Push schema to MariaDB ────────────────────────────
log "[Step 1/5] Pushing Prisma schema to MariaDB..."
cd "${APP_DIR}"

# Temporarily override DATABASE_URL to point to MariaDB
export DATABASE_URL="mysql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

# Generate Prisma client for MySQL
if bun run db:generate 2>&1; then
    ok "Prisma client generated for MariaDB"
else
    fail "Prisma generate failed. Check your DATABASE_URL in .env."
fi

# Push schema (creates tables without data)
if bun run db:push --accept-data-loss 2>&1; then
    ok "Schema pushed to MariaDB"
else
    fail "Schema push failed. Check MariaDB connection and permissions."
fi

# ── Step 2: Migrate data table by table ───────────────────────
log "[Step 2/5] Migrating data..."
MIGRATED=0
FAILED=0
SKIPPED=0

MYSQL_CMD="mysql -h ${DB_HOST} -P ${DB_PORT} -u ${DB_USER} -p${DB_PASS} ${DB_NAME}"

for table in ${SQLITE_TABLES}; do
    # Skip internal SQLite tables
    if [[ "${table}" == "_prisma_migrations" ]]; then
        SKIPPED=$(( SKIPPED + 1 ))
        continue
    fi

    # Check if table exists in MariaDB
    EXISTS=$(${MYSQL_CMD} -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB_NAME}' AND table_name='${table}';" 2>/dev/null || echo "0")
    if [[ "${EXISTS}" -eq 0 ]]; then
        warn "Table '${table}' not in MariaDB schema. Skipping."
        SKIPPED=$(( SKIPPED + 1 ))
        continue
    fi

    ROWS=$(sqlite3 "${SQLITE_DB}" "SELECT COUNT(*) FROM \"${table}\";" 2>/dev/null || echo "0")
    if [[ "${ROWS}" -eq 0 ]]; then
        log "  ${table}: 0 rows, skipping"
        SKIPPED=$(( SKIPPED + 1 ))
        continue
    fi

    log "  Migrating ${table} (${ROWS} rows)..."

    # Export from SQLite as SQL INSERT statements
    SQLITE_COLUMNS=$(sqlite3 "${SQLITE_DB}" "PRAGMA table_info(\"${table}\");" 2>/dev/null | awk -F'|' '{print $2}' | tr '\n' ',' | sed 's/,$//')

    # Get MariaDB columns for this table
    MARIA_COLUMNS=$(${MYSQL_CMD} -N -e "SELECT GROUP_CONCAT(column_name ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='${DB_NAME}' AND table_name='${table}';" 2>/dev/null)

    # Find common columns
    COMMON_COLS=""
    for col in $(echo "${SQLITE_COLUMNS}" | tr ',' ' '); do
        if echo ",${MARIA_COLUMNS}," | grep -q ",${col},"; then
            COMMON_COLS="${COMMON_COLS},${col}"
        fi
    done
    COMMON_COLS=$(echo "${COMMON_COLS}" | sed 's/^,//')

    if [[ -z "${COMMON_COLS}" ]]; then
        warn "  No common columns for ${table}. Skipping."
        SKIPPED=$(( SKIPPED + 1 ))
        continue
    fi

    # Export data as CSV from SQLite
    CSV_FILE="/tmp/alohub_migrate_${table}.csv"
    sqlite3 -header -csv "${SQLITE_DB}" "SELECT ${COMMON_COLS} FROM \"${table}\";" 2>/dev/null > "${CSV_FILE}"

    # Import into MariaDB via LOAD DATA
    if ${MYSQL_CMD} --local-infile=1 -e "
        SET FOREIGN_KEY_CHECKS=0;
        LOAD DATA LOCAL INFILE '${CSV_FILE}'
        INTO TABLE \`${table}\`
        FIELDS TERMINATED BY ',' ENCLOSED BY '\"' ESCAPED BY '\"'
        LINES TERMINATED BY '\n'
        IGNORE 1 ROWS
        (${COMMON_COLS});
        SET FOREIGN_KEY_CHECKS=1;
    " 2>/dev/null; then
        ok "  ${table}: migrated ${ROWS} rows"
        MIGRATED=$(( MIGRATED + 1 ))
    else
        # Fallback: INSERT statements
        warn "  LOAD DATA failed for ${table}, trying INSERT fallback..."
        sqlite3 "${SQLITE_DB}" ".mode insert ${table}" "SELECT ${COMMON_COLS} FROM \"${table}\";" 2>/dev/null \
            | sed "s/INSERT INTO TABLE/INSERT INTO \`${table}\`/" \
            | ${MYSQL_CMD} 2>/dev/null && ok "  ${table}: migrated via INSERT" && MIGRATED=$(( MIGRATED + 1 )) \
            || (warn "  ${table}: FAILED" && FAILED=$(( FAILED + 1 )))
    fi

    rm -f "${CSV_FILE}"
done

# ── Step 3: Verify migration ──────────────────────────────────
log "[Step 3/5] Verifying migration..."
MISMATCH=0
for table in ${SQLITE_TABLES}; do
    if [[ "${table}" == "_prisma_migrations" ]]; then continue; fi
    SQLITE_ROWS=$(sqlite3 "${SQLITE_DB}" "SELECT COUNT(*) FROM \"${table}\";" 2>/dev/null || echo "?")
    MARIA_ROWS=$(${MYSQL_CMD} -N -e "SELECT COUNT(*) FROM \`${table}\`;" 2>/dev/null || echo "?")
    if [[ "${SQLITE_ROWS}" != "${MARIA_ROWS}" ]]; then
        warn "  ${table}: SQLite=${SQLITE_ROWS}, MariaDB=${MARIA_ROWS} — MISMATCH"
        MISMATCH=$(( MISMATCH + 1 ))
    fi
done
if [[ ${MISMATCH} -eq 0 ]]; then
    ok "All row counts match"
else
    warn "${MISMATCH} table(s) have row count mismatches"
fi

# ── Step 4: Update Prisma migrations ──────────────────────────
log "[Step 4/5] Recording migration in Prisma..."
# Mark the migration as applied so Prisma doesn't try to re-create tables
${MYSQL_CMD} -e "
CREATE TABLE IF NOT EXISTS \`_prisma_migrations\` (
    \`id\` VARCHAR(36) NOT NULL PRIMARY KEY,
    \`checksum\` VARCHAR(64) NOT NULL,
    \`finished_at\` DATETIME(3),
    \`migration_name\` VARCHAR(255) NOT NULL,
    \`logs\` TEXT,
    \`rolled_back_at\` DATETIME(3),
    \`started_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`applied_steps_count\` INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
" 2>/dev/null || true

ok "Prisma migrations table ready"

# ── Step 5: Update .env and cleanup ───────────────────────────
log "[Step 5/5] Finalizing..."

# Ensure DATABASE_URL points to MariaDB
if grep -q "DATABASE_URL" "${APP_DIR}/.env"; then
    if ! grep -q "^DATABASE_URL=\"mysql://" "${APP_DIR}/.env"; then
        warn "DATABASE_URL in .env does not point to MariaDB. Update it manually."
    else
        ok "DATABASE_URL already points to MariaDB"
    fi
fi

# Fix ownership
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
chmod 600 "${APP_DIR}/.env"

# ── Summary ──────────────────────────────────────────────────
log ""
log "============================================================"
log "✅ MIGRATION COMPLETE"
log "============================================================"
log "Tables migrated: ${MIGRATED}"
log "Tables skipped:  ${SKIPPED}"
log "Tables failed:   ${FAILED}"
log "Row mismatches:  ${MISMATCH}"
log "SQLite backup:   ${BACKUP_DIR}"
log ""
log "Next steps:"
log "  1. Verify the app works: systemctl restart alolabs-agent-hub"
log "  2. Check the app:        curl http://127.0.0.1:3004/api/health"
log "  3. Run health check:     bash ${APP_DIR}/deploy/scripts/health-check.sh"
log "  4. If issues arise, restore: bash ${APP_DIR}/deploy/scripts/restore.sh --backup-id $(basename ${BACKUP_DIR})"
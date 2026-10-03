#!/usr/bin/env bash
# ============================================================
# ALO Labs Agent Hub — Backup Script
# Usage: sudo bash backup.sh [--id custom_id] [--quiet] [--db-only] [--files-only]
# ============================================================

set -euo pipefail

# ── Configuration ────────────────────────────────────────────
APP_USER="alohub"
APP_DIR="/opt/alolabs/agent-hub"
BACKUP_DIR="${APP_DIR}/backups"
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-90}
BACKUP_ID=""
QUIET=false
DB_ONLY=false
FILES_ONLY=false
UPLOAD_CMD=""  # Optional: set to upload command (e.g., "aws s3 cp")

# ── Parse arguments ──────────────────────────────────────────
for arg in "$@"; do
    case "$arg" in
        --id)        shift; BACKUP_ID="$1" ;;
        --quiet)     QUIET=true ;;
        --db-only)   DB_ONLY=true ;;
        --files-only) FILES_ONLY=true ;;
        --upload)    shift; UPLOAD_CMD="$1" ;;
        --help|-h)
            echo "Usage: sudo bash backup.sh [--id custom_id] [--quiet] [--db-only] [--files-only] [--upload 'cmd']"
            echo ""
            echo "  --id          Custom backup ID (default: auto-generated timestamp)"
            echo "  --quiet       Suppress non-error output"
            echo "  --db-only     Backup database only"
            echo "  --files-only  Backup files only (skip database)"
            echo "  --upload      Command to upload backup (receives backup path as \$1)"
            exit 0
            ;;
    esac
done

# ── Helpers ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { [[ "${QUIET}" == "false" ]] && echo -e "${GREEN}[BACKUP][$(date '+%Y-%m-%d %H:%M:%S')]${NC} $*" || true; }
warn() { [[ "${QUIET}" == "false" ]] && echo -e "${YELLOW}[BACKUP][WARN]${NC} $*" || true; }
fail() { echo -e "${RED}[BACKUP][ERROR]${NC} $*"; exit 1; }
ok()   { [[ "${QUIET}" == "false" ]] && echo -e "  ${GREEN}✅${NC} $*" || true; }

if [[ $EUID -ne 0 ]]; then fail "This script must be run as root."; fi

# ── Setup backup directory ───────────────────────────────────
BACKUP_ID="${BACKUP_ID:-$(date '+%Y%m%d_%H%M%S')}"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_ID}"
mkdir -p "${BACKUP_PATH}"

log "============================================================"
log "ALO Labs Agent Hub — Backup: ${BACKUP_ID}"
log "============================================================"
BACKUP_START=$(date +%s)

# ── Step 1: Database backup ──────────────────────────────────
if [[ "${FILES_ONLY}" == "true" ]]; then
    log "Skipping database backup (--files-only)"
else
    log "[Step 1/3] Backing up database..."

    # Extract DB credentials from .env
    source "${APP_DIR}/.env" 2>/dev/null || true

    # Parse DATABASE_URL: mysql://user:pass@host:port/db
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

    # Create encrypted database dump
    DUMP_FILE="${BACKUP_PATH}/database.sql.gz"

    if command -v mysqldump &>/dev/null; then
        if mysqldump \
            --single-transaction \
            --routines \
            --triggers \
            --set-gtid-purged=OFF \
            --column-statistics=0 \
            -h "${DB_HOST}" -P "${DB_PORT}" \
            -u "${DB_USER}" -p"${DB_PASS}" \
            "${DB_NAME}" 2>/dev/null | gzip > "${DUMP_FILE}"; then

            DUMP_SIZE=$(du -h "${DUMP_FILE}" | cut -f1)

            # Optional encryption
            if [[ -n "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
                ENCRYPTED_FILE="${DUMP_FILE}.enc"
                if echo "${BACKUP_ENCRYPTION_KEY}" | openssl enc -aes-256-cbc -salt -pbkdf2 \
                    -in "${DUMP_FILE}" -out "${ENCRYPTED_FILE}" -pass stdin 2>/dev/null; then
                    rm -f "${DUMP_FILE}"
                    mv "${ENCRYPTED_FILE}" "${DUMP_FILE}"
                    ok "Database backup encrypted and compressed (${DUMP_SIZE} → encrypted)"
                else
                    warn "Encryption failed. Backup is compressed but not encrypted."
                    ok "Database backup compressed (${DUMP_SIZE})"
                fi
            else
                ok "Database backup compressed (${DUMP_SIZE})"
            fi
        else
            fail "Database dump failed. Check MariaDB credentials and connectivity."
        fi
    else
        warn "mysqldump not found. Skipping database backup."
    fi
fi

# ── Step 2: File backup ──────────────────────────────────────
if [[ "${DB_ONLY}" == "true" ]]; then
    log "Skipping file backup (--db-only)"
else
    log "[Step 2/3] Backing up application files..."

    # Record current commit
    cd "${APP_DIR}" && git rev-parse HEAD > "${BACKUP_PATH}/commit.txt" 2>/dev/null || true
    git branch --show-current > "${BACKUP_PATH}/branch.txt" 2>/dev/null || true
    date -Iseconds > "${BACKUP_PATH}/timestamp.txt"

    # Backup .env (contains secrets)
    if [[ -f "${APP_DIR}/.env" ]]; then
        cp "${APP_DIR}/.env" "${BACKUP_PATH}/.env.bak"
        chmod 600 "${BACKUP_PATH}/.env.bak"
    fi

    # Backup .next build output
    if [[ -d "${APP_DIR}/.next" ]]; then
        tar czf "${BACKUP_PATH}/next-build.tar.gz" -C "${APP_DIR}" .next/ 2>/dev/null || true
        BUILD_SIZE=$(du -h "${BACKUP_PATH}/next-build.tar.gz" 2>/dev/null | cut -f1 || echo "0")
        ok "Build artifacts backed up (${BUILD_SIZE})"
    fi

    # Backup uploaded files / data
    if [[ -d "${APP_DIR}/data" ]] && [[ -n "$(ls -A ${APP_DIR}/data 2>/dev/null)" ]]; then
        tar czf "${BACKUP_PATH}/data.tar.gz" -C "${APP_DIR}" data/ 2>/dev/null || true
        ok "Data directory backed up"
    fi

    # Backup logs
    if [[ -d "${APP_DIR}/logs" ]] && [[ -n "$(ls -A ${APP_DIR}/logs 2>/dev/null)" ]]; then
        tar czf "${BACKUP_PATH}/logs.tar.gz" -C "${APP_DIR}" logs/ 2>/dev/null || true
        ok "Logs backed up"
    fi
fi

# ── Step 3: Create backup manifest ───────────────────────────
log "[Step 3/3] Creating backup manifest..."
BACKUP_SIZE=$(du -sh "${BACKUP_PATH}" 2>/dev/null | cut -f1)
cat > "${BACKUP_PATH}/MANIFEST.json" <<EOF
{
  "backup_id": "${BACKUP_ID}",
  "timestamp": "$(date -Iseconds)",
  "hostname": "$(hostname -f 2>/dev/null || hostname)",
  "size": "${BACKUP_SIZE}",
  "app_dir": "${APP_DIR}",
  "commit": "$(cat ${BACKUP_PATH}/commit.txt 2>/dev/null || echo 'unknown')",
  "files": $(ls -1 "${BACKUP_PATH}" | jq -R . | jq -s .)
}
EOF
ok "Manifest created"

# ── Cleanup old backups ──────────────────────────────────────
log "Cleaning up backups older than ${RETENTION_DAYS} days..."
DELETED=0
while IFS= read -r old_backup; do
    if rm -rf "${old_backup}"; then
        DELETED=$(( DELETED + 1 ))
    fi
done < <(find "${BACKUP_DIR}" -maxdepth 1 -mindepth 1 -type d -mtime "+${RETENTION_DAYS}" 2>/dev/null)
if [[ ${DELETED} -gt 0 ]]; then
    ok "Removed ${DELETED} old backup(s)"
fi

# ── Optional upload ──────────────────────────────────────────
if [[ -n "${UPLOAD_CMD}" ]]; then
    log "Uploading backup..."
    if eval "${UPLOAD_CMD} ${BACKUP_PATH}"; then
        ok "Backup uploaded"
    else
        warn "Upload failed. Backup is available locally at ${BACKUP_PATH}"
    fi
fi

# ── Summary ──────────────────────────────────────────────────
BACKUP_DURATION=$(( $(date +%s) - BACKUP_START ))

log ""
log "============================================================"
log "✅ BACKUP COMPLETE"
log "============================================================"
log "ID:       ${BACKUP_ID}"
log "Path:     ${BACKUP_PATH}"
log "Size:     ${BACKUP_SIZE}"
log "Duration: ${BACKUP_DURATION}s"
log ""
log "To restore: sudo bash ${APP_DIR}/deploy/scripts/restore.sh --backup-id ${BACKUP_ID}"
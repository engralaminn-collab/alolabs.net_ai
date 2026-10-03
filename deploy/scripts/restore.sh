#!/usr/bin/env bash
# ============================================================
# ALO Labs Agent Hub — Restore Script
# Usage: sudo bash restore.sh --backup-id ID [--db-only] [--files-only] [--skip-db-restore]
# ============================================================

set -euo pipefail

# ── Configuration ────────────────────────────────────────────
APP_USER="alohub"
APP_GROUP="${APP_GROUP:-alohub}"
APP_DIR="/opt/alolabs/agent-hub"
BACKUP_DIR="${APP_DIR}/backups"
SERVICE_NAME="alolabs-agent-hub"
BACKUP_ID=""
DB_ONLY=false
FILES_ONLY=false
SKIP_DB_RESTORE=false

# ── Parse arguments ──────────────────────────────────────────
for arg in "$@"; do
    case "$arg" in
        --backup-id)         shift; BACKUP_ID="$1" ;;
        --db-only)           DB_ONLY=true ;;
        --files-only)        FILES_ONLY=true ;;
        --skip-db-restore)   SKIP_DB_RESTORE=true ;;
        --help|-h)
            echo "Usage: sudo bash restore.sh --backup-id ID [options]"
            echo ""
            echo "  --backup-id         Backup ID to restore from (required)"
            echo "  --db-only           Restore database only"
            echo "  --files-only        Restore files only"
            echo "  --skip-db-restore   Restore files but skip database restore"
            exit 0
            ;;
    esac
done

# ── Helpers ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[RESTORE][$(date '+%Y-%m-%d %H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[RESTORE][WARN]${NC} $*"; }
fail() { echo -e "${RED}[RESTORE][ERROR]${NC} $*"; exit 1; }
ok()   { echo -e "  ${GREEN}✅${NC} $*"; }

if [[ $EUID -ne 0 ]]; then fail "This script must be run as root."; fi

# ── Validate backup ──────────────────────────────────────────
if [[ -z "${BACKUP_ID}" ]]; then
    fail "Backup ID required. Use --backup-id."
fi

BACKUP_PATH="${BACKUP_DIR}/${BACKUP_ID}"
if [[ ! -d "${BACKUP_PATH}" ]]; then
    # Try to find a backup that starts with this ID (partial match)
    MATCH=$(find "${BACKUP_DIR}" -maxdepth 1 -mindepth 1 -type d -name "${BACKUP_ID}*" | head -1)
    if [[ -n "${MATCH}" ]]; then
        BACKUP_PATH="${MATCH}"
        warn "Using matched backup: ${BACKUP_PATH}"
    else
        fail "Backup not found: ${BACKUP_PATH}"
    fi
fi

# Show backup info
if [[ -f "${BACKUP_PATH}/MANIFEST.json" ]]; then
    log "Backup manifest:"
    jq '.' "${BACKUP_PATH}/MANIFEST.json" 2>/dev/null || true
fi

log "============================================================"
log "ALO Labs Agent Hub — Restore"
log "============================================================"
log "Backup:     ${BACKUP_ID}"
log "Path:       ${BACKUP_PATH}"
log ""

# ── Confirmation ─────────────────────────────────────────────
echo -e "${RED}⚠️  WARNING: This will OVERWRITE current data with backup from:${NC}"
echo -e "${RED}   ${BACKUP_PATH}${NC}"
if [[ -f "${BACKUP_PATH}/timestamp.txt" ]]; then
    echo -e "${RED}   Backup time: $(cat ${BACKUP_PATH}/timestamp.txt)${NC}"
fi
echo -e "${YELLOW}   Database: ${DB_ONLY} → DB only | ${FILES_ONLY} → Files only | else → Full restore${NC}"
read -rp "Type 'RESTORE' to confirm: " CONFIRM
if [[ "${CONFIRM}" != "RESTORE" ]]; then
    log "Restore cancelled."
    exit 0
fi

RESTORE_START=$(date +%s)

# ── Step 1: Create pre-restore safety backup ─────────────────
log "[Step 1/4] Creating safety backup before restore..."
SAFE_BACKUP="${BACKUP_DIR}/pre_restore_$(date '+%Y%m%d_%H%M%S')"
mkdir -p "${SAFE_BACKUP}"

if [[ -d "${APP_DIR}/.next" ]]; then
    cp -a "${APP_DIR}/.next" "${SAFE_BACKUP}/.next.bak" 2>/dev/null || true
fi
if [[ -f "${APP_DIR}/.env" ]]; then
    cp "${APP_DIR}/.env" "${SAFE_BACKUP}/.env.bak" 2>/dev/null || true
fi
cd "${APP_DIR}" && git rev-parse HEAD > "${SAFE_BACKUP}/commit.txt" 2>/dev/null || true
ok "Safety backup: ${SAFE_BACKUP}"

# ── Step 2: Stop service ─────────────────────────────────────
log "[Step 2/4] Stopping service..."
systemctl stop "${SERVICE_NAME}" 2>/dev/null || warn "Service was not running"
ok "Service stopped"

# ── Step 3: Restore files ────────────────────────────────────
if [[ "${DB_ONLY}" == "true" ]]; then
    log "[Step 3/4] Skipping file restore (--db-only)"
else
    log "[Step 3/4] Restoring files..."

    # Restore .env
    if [[ -f "${BACKUP_PATH}/.env.bak" ]]; then
        cp "${BACKUP_PATH}/.env.bak" "${APP_DIR}/.env"
        chmod 600 "${APP_DIR}/.env"
        ok ".env restored"
    else
        warn ".env.bak not found in backup. Current .env preserved."
    fi

    # Restore .next build
    if [[ -f "${BACKUP_PATH}/next-build.tar.gz" ]]; then
        rm -rf "${APP_DIR}/.next"
        tar xzf "${BACKUP_PATH}/next-build.tar.gz" -C "${APP_DIR}" 2>/dev/null
        ok "Build artifacts restored"
    elif [[ -f "${BACKUP_PATH}/.next.bak" ]] && [[ -d "${BACKUP_PATH}/.next.bak" ]]; then
        rm -rf "${APP_DIR}/.next"
        cp -a "${BACKUP_PATH}/.next.bak" "${APP_DIR}/.next"
        ok "Build artifacts restored"
    else
        warn "No build artifacts in backup. You may need to rebuild: cd ${APP_DIR} && bun run build"
    fi

    # Restore data directory
    if [[ -f "${BACKUP_PATH}/data.tar.gz" ]]; then
        tar xzf "${BACKUP_PATH}/data.tar.gz" -C "${APP_DIR}" 2>/dev/null
        ok "Data directory restored"
    fi

    # Restore logs
    if [[ -f "${BACKUP_PATH}/logs.tar.gz" ]]; then
        tar xzf "${BACKUP_PATH}/logs.tar.gz" -C "${APP_DIR}" 2>/dev/null
        ok "Logs restored"
    fi

    chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
fi

# ── Step 4: Restore database ─────────────────────────────────
if [[ "${FILES_ONLY}" == "true" ]] || [[ "${SKIP_DB_RESTORE}" == "true" ]]; then
    log "[Step 4/4] Skipping database restore"
else
    log "[Step 4/4] Restoring database..."

    DB_DUMP=""
    if [[ -f "${BACKUP_PATH}/database.sql.gz" ]]; then
        DB_DUMP="${BACKUP_PATH}/database.sql.gz"
    elif [[ -f "${BACKUP_PATH}/database.sql.gz.enc" ]]; then
        # Encrypted dump
        DB_DUMP="${BACKUP_PATH}/database.sql.gz.enc"
    fi

    if [[ -z "${DB_DUMP}" ]]; then
        warn "No database dump found in backup. Skipping database restore."
    else
        # Decrypt if needed
        if [[ "${DB_DUMP}" == *.enc ]]; then
            source "${APP_DIR}/.env" 2>/dev/null || true
            DECRYPTED="/tmp/alohub_restore_$$.sql.gz"
            if echo "${BACKUP_ENCRYPTION_KEY:-}" | openssl enc -d -aes-256-cbc -pbkdf2 \
                -in "${DB_DUMP}" -out "${DECRYPTED}" -pass stdin 2>/dev/null; then
                DB_DUMP="${DECRYPTED}"
                ok "Database dump decrypted"
            else
                fail "Decryption failed. Check BACKUP_ENCRYPTION_KEY in .env"
            fi
        fi

        # Extract DB credentials
        source "${APP_DIR}/.env" 2>/dev/null || true
        if [[ -n "${DATABASE_URL:-}" ]]; then
            DB_USER=$(echo "${DATABASE_URL}" | sed -n 's|mysql://\([^:]*\):\([^@]*\)@\([^:]*\):\([0-9]*\)/\(.*\)|\1|p')
            DB_PASS=$(echo "${DATABASE_URL}" | sed -n 's|mysql://\([^:]*\):\([^@]*\)@\([^:]*\):\([0-9]*\)/\(.*\)|\2|p')
            DB_HOST=$(echo "${DATABASE_URL}" | sed -n 's|mysql://\([^:]*\):\([^@]*\)@\([^:]*\):\([0-9]*\)/\(.*\)|\3|p')
            DB_PORT=$(echo "${DATABASE_URL}" | sed -n 's|mysql://\([^:]*\):\([^@]*\)@\([^:]*\):\([0-9]*\)/\(.*\)|\4|p')
            DB_NAME=$(echo "${DATABASE_URL}" | sed -n 's|mysql://\([^:]*\):\([^@]*\)@\([^:]*\):\([0-9]*\)/\(.*\)|\5|p')
        fi

        # Drop and recreate database
        log "  Dropping and recreating database ${DB_NAME}..."
        mysql -h "${DB_HOST}" -P "${DB_PORT}" -u "${DB_USER}" -p"${DB_PASS}" \
            -e "DROP DATABASE IF EXISTS \`${DB_NAME}\`; CREATE DATABASE \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null \
            || fail "Failed to recreate database."

        # Import dump
        log "  Importing database dump..."
        if gunzip -c "${DB_DUMP}" | mysql -h "${DB_HOST}" -P "${DB_PORT}" -u "${DB_USER}" -p"${DB_PASS}" "${DB_NAME}" 2>/dev/null; then
            ok "Database restored successfully"
        else
            fail "Database import failed."
        fi

        # Cleanup decrypted file
        if [[ "${DB_DUMP}" == /tmp/* ]]; then
            rm -f "${DB_DUMP}"
        fi
    fi
fi

# ── Restart service ──────────────────────────────────────────
log "Restarting service..."
systemctl start "${SERVICE_NAME}"

sleep 5
if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
    ok "Service started successfully"
else
    warn "Service failed to start. Check: journalctl -u ${SERVICE_NAME} -n 50"
fi

# ── Summary ──────────────────────────────────────────────────
RESTORE_DURATION=$(( $(date +%s) - RESTORE_START ))

log ""
log "============================================================"
log "✅ RESTORE COMPLETE"
log "============================================================"
log "Backup ID:   ${BACKUP_ID}"
log "Safety save: ${SAFE_BACKUP}"
log "Duration:    ${RESTORE_DURATION}s"
log ""
log "Commands:"
log "  Check service:  systemctl status ${SERVICE_NAME}"
log "  View logs:      journalctl -u ${SERVICE_NAME} -f"
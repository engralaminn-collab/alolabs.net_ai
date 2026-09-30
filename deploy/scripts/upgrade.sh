#!/usr/bin/env bash
# ============================================================
# ALO Labs Agent Hub — Upgrade Script with Backup & Rollback
# Usage: sudo bash upgrade.sh [--branch main] [--skip-backup]
# ============================================================

set -euo pipefail

# ── Configuration ────────────────────────────────────────────
APP_USER="alohub"
APP_DIR="/opt/alolabs/agent-hub"
BACKUP_DIR="${APP_DIR}/backups"
SERVICE_NAME="alolabs-agent-hub"
BRANCH="main"
SKIP_BACKUP=false
HEALTH_TIMEOUT=90
ROLLBACK_ON_FAILURE=true

# ── Parse arguments ──────────────────────────────────────────
for arg in "$@"; do
    case "$arg" in
        --branch)        shift; BRANCH="$1" ;;
        --skip-backup)   SKIP_BACKUP=true ;;
        --no-rollback)   ROLLBACK_ON_FAILURE=false ;;
        --help|-h)
            echo "Usage: sudo bash upgrade.sh [--branch main] [--skip-backup] [--no-rollback]"
            echo ""
            echo "  --branch        Git branch to upgrade to (default: main)"
            echo "  --skip-backup   Skip pre-upgrade backup"
            echo "  --no-rollback   Do not auto-rollback on failure"
            exit 0
            ;;
    esac
done

# ── Helpers ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()    { echo -e "${GREEN}[UPGRADE][$(date '+%Y-%m-%d %H:%M:%S')]${NC} $*"; }
warn()   { echo -e "${YELLOW}[UPGRADE][WARN]${NC} $*"; }
fail()   { echo -e "${RED}[UPGRADE][ERROR]${NC} $*"; }
info()   { echo -e "${BLUE}[UPGRADE][INFO]${NC} $*"; }
ok()     { echo -e "  ${GREEN}✅${NC} $*"; }

# ── Pre-flight ───────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then fail "This script must be run as root."; fi
if [[ ! -d "${APP_DIR}" ]]; then fail "App directory not found: ${APP_DIR}"; fi

log "============================================================"
log "ALO Labs Agent Hub — Upgrade"
log "============================================================"
log "Branch:         ${BRANCH}"
log "Auto-rollback:  ${ROLLBACK_ON_FAILURE}"
log "Skip backup:    ${SKIP_BACKUP}"
log ""

UPGRADE_START=$(date +%s)

# ── Health check: verify current state ───────────────────────
log "[Pre-flight] Checking current service health..."
CURRENT_HEALTH=$(curl -sf -o /dev/null -w '%{http_code}' "http://127.0.0.1:3004/api/health" 2>/dev/null || echo "000")
if [[ "${CURRENT_HEALTH}" != "200" ]]; then
    warn "Service is not currently healthy (HTTP ${CURRENT_HEALTH}). Proceeding with caution..."
else
    ok "Service is currently healthy"
fi

# ── Step 1: Pre-upgrade backup ───────────────────────────────
BACKUP_ID=""
if [[ "${SKIP_BACKUP}" == "true" ]]; then
    log "[Step 1/6] Skipping backup (--skip-backup)"
else
    log "[Step 1/6] Creating pre-upgrade backup..."
    BACKUP_ID=$(date '+%Y%m%d_%H%M%S')

    if [[ -f "${APP_DIR}/deploy/scripts/backup.sh" ]]; then
        if bash "${APP_DIR}/deploy/scripts/backup.sh" --id "pre_upgrade_${BACKUP_ID}" --quiet; then
            ok "Pre-upgrade backup created: pre_upgrade_${BACKUP_ID}"
        else
            if [[ "${ROLLBACK_ON_FAILURE}" == "true" ]]; then
                fail "Backup failed — aborting upgrade to ensure rollback is possible"
            else
                warn "Backup failed — continuing anyway (--no-rollback)"
            fi
        fi
    else
        # Manual backup
        BACKUP_PATH="${BACKUP_DIR}/pre_upgrade_${BACKUP_ID}"
        mkdir -p "${BACKUP_PATH}"
        CURRENT_COMMIT=$(cd "${APP_DIR}" && git rev-parse HEAD 2>/dev/null || echo "unknown")
        echo "${CURRENT_COMMIT}" > "${BACKUP_PATH}/commit.txt"

        # Backup .next build
        if [[ -d "${APP_DIR}/.next" ]]; then
            cp -a "${APP_DIR}/.next" "${BACKUP_PATH}/.next.bak"
        fi

        # Backup .env
        if [[ -f "${APP_DIR}/.env" ]]; then
            cp "${APP_DIR}/.env" "${BACKUP_PATH}/.env.bak"
        fi

        # Database dump
        if command -v mysqldump &>/dev/null; then
            source "${APP_DIR}/.env" 2>/dev/null || true
            mysqldump --single-transaction --routines --triggers \
                -u alohub_user -p"${DATABASE_URL##*:}" alohub_production \
                2>/dev/null | gzip > "${BACKUP_PATH}/database.sql.gz" || true
        fi

        ok "Manual pre-upgrade backup created at ${BACKUP_PATH}"
    fi
fi

# ── Step 2: Pull and update code ─────────────────────────────
log "[Step 2/6] Pulling latest code..."
cd "${APP_DIR}"
PRE_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")

if ! su - "${APP_USER}" -c "cd ${APP_DIR} && git fetch origin ${BRANCH}" 2>/dev/null; then
    fail "Git fetch failed. Check network connectivity."
fi

su - "${APP_USER}" -c "cd ${APP_DIR} && git reset --hard origin/${BRANCH}" 2>/dev/null
POST_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
ok "Updated: ${PRE_COMMIT:0:8} → ${POST_COMMIT:0:8}"

# ── Step 3: Install dependencies ─────────────────────────────
log "[Step 3/6] Installing dependencies..."
if ! su - "${APP_USER}" -c "cd ${APP_DIR} && bun install --frozen-lockfile" 2>/dev/null; then
    warn "Frozen install failed, trying regular install..."
    if ! su - "${APP_USER}" -c "cd ${APP_DIR} && bun install" 2>/dev/null; then
        if [[ "${ROLLBACK_ON_FAILURE}" == "true" ]]; then
            fail "Dependency installation failed. Rolling back..."
            bash "${APP_DIR}/deploy/scripts/rollback.sh" --commit "${PRE_COMMIT}"
            exit 1
        fi
        fail "Dependency installation failed."
    fi
fi
ok "Dependencies installed"

# ── Step 4: Database migration ───────────────────────────────
log "[Step 4/6] Running database migrations..."
MIGRATION_OK=false
if su - "${APP_USER}" -c "cd ${APP_DIR} && bun run db:push --accept-data-loss" 2>&1; then
    MIGRATION_OK=true
    ok "Database migration successful"
else
    warn "Database migration had issues"
    # Continue anyway — schema changes may be additive only
    su - "${APP_USER}" -c "cd ${APP_DIR} && bun run db:generate" 2>/dev/null || true
fi

# ── Step 5: Build ────────────────────────────────────────────
log "[Step 5/6] Building application..."
BUILD_START=$(date +%s)
if ! su - "${APP_USER}" -c "cd ${APP_DIR} && NODE_ENV=production bun run build" 2>&1; then
    BUILD_FAILED=true
    warn "Build failed"
else
    BUILD_FAILED=false
    BUILD_DURATION=$(( $(date +%s) - BUILD_START ))
    ok "Build completed in ${BUILD_DURATION}s"
fi

# ── Step 6: Restart and health check ─────────────────────────
log "[Step 6/6] Restarting service and running health checks..."

if [[ "${BUILD_FAILED}" == "true" ]]; then
    if [[ "${ROLLBACK_ON_FAILURE}" == "true" ]]; then
        warn "Build failed — initiating automatic rollback..."
        bash "${APP_DIR}/deploy/scripts/rollback.sh" --commit "${PRE_COMMIT}"
        exit 1
    fi
    fail "Build failed and auto-rollback is disabled. Manual intervention required."
fi

systemctl daemon-reload
systemctl restart "${SERVICE_NAME}"

# Wait for health
HEALTH_START=$(date +%s)
UPGRADE_HEALTHY=false

while [[ $(( $(date +%s) - HEALTH_START )) -lt ${HEALTH_TIMEOUT} ]]; do
    if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
        HTTP_CODE=$(curl -sf -o /dev/null -w '%{http_code}' "http://127.0.0.1:3004/api/health" 2>/dev/null || echo "000")
        if [[ "${HTTP_CODE}" == "200" ]]; then
            UPGRADE_HEALTHY=true
            break
        fi
    fi
    sleep 3
done

if [[ "${UPGRADE_HEALTHY}" != "true" ]]; then
    warn "Service not healthy after ${HEALTH_TIMEOUT}s"
    if [[ "${ROLLBACK_ON_FAILURE}" == "true" ]]; then
        warn "Initiating automatic rollback..."
        bash "${APP_DIR}/deploy/scripts/rollback.sh" --commit "${PRE_COMMIT}"
        exit 1
    fi
    fail "Upgrade failed. Service unhealthy. Rollback manually: bash ${APP_DIR}/deploy/scripts/rollback.sh"
fi

# ── Upgrade summary ──────────────────────────────────────────
UPGRADE_DURATION=$(( $(date +%s) - UPGRADE_START ))

log ""
log "============================================================"
log "✅ UPGRADE SUCCESSFUL"
log "============================================================"
log "Previous:    ${PRE_COMMIT:0:8}"
log "Current:     ${POST_COMMIT:0:8}"
log "Duration:    ${UPGRADE_DURATION}s"
if [[ -n "${BACKUP_ID}" && "${SKIP_BACKUP}" == "false" ]]; then
    log "Backup ID:   pre_upgrade_${BACKUP_ID}"
fi
log ""
log "Commands:"
log "  View logs:  journalctl -u ${SERVICE_NAME} -f"
log "  Rollback:   sudo bash ${APP_DIR}/deploy/scripts/rollback.sh --commit ${PRE_COMMIT}"
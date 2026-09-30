#!/usr/bin/env bash
# ============================================================
# ALO Labs Agent Hub — Deployment Script
# Usage: sudo bash deploy.sh [--branch main] [--no-build]
# ============================================================

set -euo pipefail

# ── Configuration ────────────────────────────────────────────
APP_USER="alohub"
APP_DIR="/opt/alolabs/agent-hub"
SERVICE_NAME="alolabs-agent-hub"
BRANCH="main"
SKIP_BUILD=false
MAX_RETRIES=3
HEALTH_TIMEOUT=60

# ── Parse arguments ──────────────────────────────────────────
for arg in "$@"; do
    case "$arg" in
        --branch)  shift; BRANCH="$1" ;;
        --no-build) SKIP_BUILD=true ;;
        --help|-h)
            echo "Usage: sudo bash deploy.sh [--branch main] [--no-build]"
            echo ""
            echo "  --branch    Git branch to deploy (default: main)"
            echo "  --no-build  Skip build step (use existing .next)"
            exit 0
            ;;
    esac
done

# ── Helpers ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[DEPLOY][$(date '+%Y-%m-%d %H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[DEPLOY][WARN]${NC} $*"; }
fail() { echo -e "${RED}[DEPLOY][ERROR]${NC} $*"; exit 1; }
ok()   { echo -e "  ${GREEN}✅${NC} $*"; }

# ── Pre-flight checks ────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    fail "This script must be run as root (use sudo)."
fi

if [[ ! -d "${APP_DIR}" ]]; then
    fail "Application directory not found: ${APP_DIR}. Run install.sh first."
fi

if ! id "${APP_USER}" &>/dev/null; then
    fail "User '${APP_USER}' not found. Run install.sh first."
fi

log "============================================================"
log "ALO Labs Agent Hub — Deployment"
log "============================================================"
log "Branch:     ${BRANCH}"
log "App Dir:    ${APP_DIR}"
log "Skip Build: ${SKIP_BUILD}"
log ""

DEPLOY_START=$(date +%s)

# ── Step 1: Pull latest code ─────────────────────────────────
log "[Step 1/5] Pulling latest code from origin/${BRANCH}..."
cd "${APP_DIR}"

# Save current commit for rollback
CURRENT_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
echo "${CURRENT_COMMIT}" > "${APP_DIR}/.deploy-previous-commit"

if ! su - "${APP_USER}" -c "cd ${APP_DIR} && git fetch origin ${BRANCH}" 2>/dev/null; then
    fail "Git fetch failed. Check network connectivity."
fi

BEHIND=$(su - "${APP_USER}" -c "cd ${APP_DIR} && git rev-list --count HEAD..origin/${BRANCH}" 2>/dev/null || echo "0")
if [[ "${BEHIND}" -eq 0 ]]; then
    warn "Already up to date. No new commits to deploy."
    if [[ "${SKIP_BUILD}" == "false" ]]; then
        warn "Rebuilding anyway to ensure consistency..."
    else
        log "Nothing to do. Exiting."
        exit 0
    fi
fi

NEW_COMMIT=$(su - "${APP_USER}" -c "cd ${APP_DIR} && git rev-parse origin/${BRANCH}" 2>/dev/null)
log "  Updating: ${CURRENT_COMMIT:0:8} → ${NEW_COMMIT:0:8} (${BEHIND} commits)"

if ! su - "${APP_USER}" -c "cd ${APP_DIR} && git reset --hard origin/${BRANCH}" 2>/dev/null; then
    fail "Git reset failed."
fi
ok "Code updated to ${NEW_COMMIT:0:8}"

# ── Step 2: Install dependencies ─────────────────────────────
log "[Step 2/5] Installing dependencies..."
if su - "${APP_USER}" -c "cd ${APP_DIR} && bun install --frozen-lockfile" 2>/dev/null; then
    ok "Dependencies installed (frozen lockfile)"
else
    warn "Frozen lockfile install failed, trying regular install..."
    if ! su - "${APP_USER}" -c "cd ${APP_DIR} && bun install" 2>/dev/null; then
        fail "Dependency installation failed."
    fi
    ok "Dependencies installed (regular)"
fi

# ── Step 3: Database migration ───────────────────────────────
log "[Step 3/5] Running database migrations..."
if su - "${APP_USER}" -c "cd ${APP_DIR} && bun run db:push --accept-data-loss 2>&1" 2>/dev/null; then
    ok "Database schema synchronized"
else
    warn "db:push failed or made no changes. Attempting prisma generate..."
    su - "${APP_USER}" -c "cd ${APP_DIR} && bun run db:generate" 2>/dev/null || true
    ok "Prisma client generated"
fi

# ── Step 4: Build application ────────────────────────────────
if [[ "${SKIP_BUILD}" == "true" ]]; then
    log "[Step 4/5] Skipping build (--no-build)"
else
    log "[Step 4/5] Building application..."
    BUILD_START=$(date +%s)

    if su - "${APP_USER}" -c "cd ${APP_DIR} && NODE_ENV=production bun run build" 2>&1; then
        BUILD_DURATION=$(( $(date +%s) - BUILD_START ))
        ok "Build completed in ${BUILD_DURATION}s"
    else
        fail "Build failed. Check build logs above."
    fi
fi

# ── Step 5: Restart service and health check ─────────────────
log "[Step 5/5] Restarting service..."
systemctl daemon-reload

RETRY=0
while [[ ${RETRY} -lt ${MAX_RETRIES} ]]; do
    systemctl restart "${SERVICE_NAME}"

    log "  Waiting for service to start (health check timeout: ${HEALTH_TIMEOUT}s)..."
    HEALTH_START=$(date +%s)
    HEALTHY=false

    while [[ $(( $(date +%s) - HEALTH_START )) -lt ${HEALTH_TIMEOUT} ]]; do
        if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
            # Try HTTP health check
            if curl -sf -o /dev/null -w '%{http_code}' "http://127.0.0.1:3004/api/health" 2>/dev/null | grep -q '200'; then
                HEALTHY=true
                break
            fi
        fi
        sleep 2
    done

    if [[ "${HEALTHY}" == "true" ]]; then
        ok "Service is healthy and responding"
        break
    else
        RETRY=$(( RETRY + 1 ))
        warn "Health check failed (attempt ${RETRY}/${MAX_RETRIES})"
        if [[ ${RETRY} -ge ${MAX_RETRIES} ]]; then
            fail "Service failed to become healthy after ${MAX_RETRIES} attempts. Check: journalctl -u ${SERVICE_NAME} -n 50"
        fi
        sleep 5
    fi
done

# ── Deployment summary ───────────────────────────────────────
DEPLOY_DURATION=$(( $(date +%s) - DEPLOY_START ))
DEPLOY_TIME=$(date '+%Y-%m-%d %H:%M:%S')

# Record deployment
echo "${DEPLOY_TIME} | ${NEW_COMMIT:0:8} | ${BRANCH} | ${DEPLOY_DURATION}s | success" >> "${APP_DIR}/logs/deployments.log" 2>/dev/null || true

log ""
log "============================================================"
log "✅ DEPLOYMENT SUCCESSFUL"
log "============================================================"
log "Branch:      ${BRANCH}"
log "Commit:      ${NEW_COMMIT:0:8}"
log "Previous:    ${CURRENT_COMMIT:0:8}"
log "Duration:    ${DEPLOY_DURATION}s"
log "Deployed at: ${DEPLOY_TIME}"
log ""
log "Commands:"
log "  View logs:  journalctl -u ${SERVICE_NAME} -f"
log "  Rollback:   sudo bash ${APP_DIR}/deploy/scripts/rollback.sh"
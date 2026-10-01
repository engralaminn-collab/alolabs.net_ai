#!/usr/bin/env bash
# ============================================================
# ALO Labs Agent Hub — Full Installation Script
# Target: Ubuntu 22.04 LTS (clean or existing server)
# Usage: sudo bash install.sh [--skip-db] [--skip-redis]
# ============================================================

set -euo pipefail

# ── Configuration ────────────────────────────────────────────
APP_USER="alohub"
APP_GROUP="alohub"
APP_DIR="/opt/alolabs/agent-hub"
APP_REPO="https://github.com/alolabs/agent-hub.git"
APP_BRANCH="main"
BUN_VERSION="1.2.5"
DB_NAME="alohub_production"
DB_USER="alohub_user"
DB_PASS=""  # Generated below
SKIP_DB=false
SKIP_REDIS=false
SKIP_BUN=false

# ── Parse arguments ──────────────────────────────────────────
for arg in "$@"; do
    case "$arg" in
        --skip-db)     SKIP_DB=true ;;
        --skip-redis)  SKIP_REDIS=true ;;
        --skip-bun)    SKIP_BUN=true ;;
        --help|-h)
            echo "Usage: sudo bash install.sh [--skip-db] [--skip-redis] [--skip-bun]"
            echo ""
            echo "  --skip-db     Skip MariaDB installation and configuration"
            echo "  --skip-redis  Skip Redis installation and configuration"
            echo "  --skip-bun    Skip Bun installation (use existing)"
            exit 0
            ;;
    esac
done

# ── Helpers ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
ok()   { echo -e "  ${GREEN}✅${NC} $*"; }

# ── Pre-flight checks ────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    fail "This script must be run as root (use sudo)."
fi

if [[ ! -f /etc/os-release ]]; then
    fail "Cannot detect OS. This script requires Ubuntu 22.04."
fi

OS_ID=$(grep '^ID=' /etc/os-release | cut -d= -f2 | tr -d '"')
OS_VER=$(grep '^VERSION_ID=' /etc/os-release | cut -d= -f2 | tr -d '"')
if [[ "${OS_ID}" != "ubuntu" && "${OS_ID}" != "debian" ]]; then
    warn "This script is designed for Ubuntu 20.04/22.04/24.04 or Debian 11/12. Detected: ${OS_ID} ${OS_VER}"
    warn "Continuing installation."
fi

log "============================================================"
log "ALO Labs Agent Hub — Installation"
log "============================================================"
log "OS:         ${OS_ID} ${OS_VER}"
log "App Dir:    ${APP_DIR}"
log "Skip DB:    ${SKIP_DB}"
log "Skip Redis: ${SKIP_REDIS}"
log ""

# ── Step 1: System updates ───────────────────────────────────
log "[Step 1/9] Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get dist-upgrade -y -qq
ok "System packages updated"

# ── Step 2: Install essential dependencies ───────────────────
log "[Step 2/9] Installing essential system packages..."
apt-get install -y -qq \
    curl wget git build-essential \
    ca-certificates gnupg lsb-release \
    ufw fail2ban \
    nginx \
    cron logrotate \
    apt-transport-https software-properties-common \
    jq unzip xz-utils \
    2>/dev/null
ok "Essential packages installed"

# ── Step 3: Install Bun ──────────────────────────────────────
log "[Step 3/9] Installing Bun runtime..."
if command -v bun &>/dev/null && [[ "${SKIP_BUN}" == "false" ]]; then
    BUN_INSTALLED_VER=$(bun --version 2>/dev/null || echo "unknown")
    warn "Bun already installed (v${BUN_INSTALLED_VER}). Skipping."
else
    # Install Bun for all users
    curl -fsSL "https://bun.sh/install" | bash -s "bun-v${BUN_VERSION}" 2>/dev/null
    # Make accessible system-wide
    if [[ -f /root/.bun/bin/bun ]]; then
        ln -sf /root/.bun/bin/bun /usr/local/bin/bun
        ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx
    fi
    if command -v bun &>/dev/null; then
        ok "Bun $(bun --version) installed"
    else
        fail "Bun installation failed"
    fi
fi

# ── Step 4: Install MariaDB ──────────────────────────────────
log "[Step 4/9] Installing MariaDB..."
if [[ "${SKIP_DB}" == "true" ]]; then
    warn "Skipping MariaDB installation (--skip-db)"
else
    # Add MariaDB repo (10.11 LTS)
    if ! command -v mariadb &>/dev/null; then
        curl -fsSL https://mariadb.org/mariadb_release_signing_key.asc | gpg --dearmor \
            -o /usr/share/keyrings/mariadb-keyring.gpg 2>/dev/null
        echo "deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/mariadb-keyring.gpg] https://mariadb.mirror.liquidtelecom.com/repo/10.11/ubuntu $(lsb_release -cs) main" \
            > /etc/apt/sources.list.d/mariadb.list
        apt-get update -qq
        apt-get install -y -qq mariadb-server 2>/dev/null
    fi

    # Secure MariaDB
    log "  Securing MariaDB installation..."
    mysql -u root <<'SQL'
-- Remove anonymous users
DELETE FROM mysql.user WHERE User='';
-- Disallow remote root login
DELETE FROM mysql.user WHERE User='root' AND Host NOT IN ('localhost', '127.0.0.1', '::1');
-- Remove test database
DROP DATABASE IF EXISTS test;
DELETE FROM mysql.db WHERE Db='test' OR Db='test\\_%';
-- Flush privileges
FLUSH PRIVILEGES;
SQL

    # Generate a strong DB password
    DB_PASS=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)

    # Create database and user
    mysql -u root <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

    # Optimize MariaDB config
    cat > /etc/mysql/mariadb.conf.d/99-alolabs.cnf <<'MYCNF'
[mysqld]
# Connection
max_connections = 200
max_allowed_packet = 64M

# InnoDB
innodb_buffer_pool_size = 512M
innodb_log_file_size = 128M
innodb_flush_log_at_trx_commit = 2
innodb_flush_method = O_DIRECT

# Query cache (MariaDB 10.x)
query_cache_type = 0
query_cache_size = 0

# Logging
slow_query_log = 1
slow_query_log_file = /var/log/mysql/mariadb-slow.log
long_query_time = 2

# Character set
character-set-server = utf8mb4
collation-server = utf8mb4_unicode_ci
MYCNF

    systemctl enable mariadb
    systemctl restart mariadb
    ok "MariaDB 10.11 installed and secured (db: ${DB_NAME}, user: ${DB_USER})"
    warn "DB Password: ${DB_PASS} — SAVE THIS! It will not be shown again."
fi

# ── Step 5: Install Redis ────────────────────────────────────
log "[Step 5/9] Installing Redis..."
if [[ "${SKIP_REDIS}" == "true" ]]; then
    warn "Skipping Redis installation (--skip-redis)"
else
    if ! command -v redis-server &>/dev/null; then
        apt-get install -y -qq redis-server 2>/dev/null
    fi

    # Harden Redis config
    cat > /etc/redis/redis-local.conf <<'REDCONF'
# Bind to localhost only
bind 127.0.0.1 ::1

# Disable dangerous commands
rename-command FLUSHDB ""
rename-command FLUSHALL ""
rename-command DEBUG ""

# Require password
# (Set via: requirepass YOUR_REDIS_PASSWORD in redis.conf)
# For now, rely on localhost-only binding

# Memory
maxmemory 256mb
maxmemory-policy allkeys-lru

# Persistence
save 900 1
save 300 10
save 60 10000

# Security
protected-mode yes
port 6379
tcp-backlog 511
timeout 300
tcp-keepalive 60
loglevel notice
REDCONF

    # Append local overrides
    if ! grep -q "include /etc/redis/redis-local.conf" /etc/redis/redis.conf; then
        echo "include /etc/redis/redis-local.conf" >> /etc/redis/redis.conf
    fi

    systemctl enable redis-server
    systemctl restart redis-server
    ok "Redis installed and hardened (localhost only, 256MB max)"
fi

# ── Step 6: Create application user ──────────────────────────
log "[Step 6/9] Creating application user..."
if id "${APP_USER}" &>/dev/null; then
    warn "User '${APP_USER}' already exists. Skipping creation."
else
    useradd -r -m -d "${APP_DIR}" -s /bin/bash -g "${APP_GROUP}" "${APP_USER}"
    ok "User '${APP_USER}' created (home: ${APP_DIR})"
fi

# ── Step 7: Clone and set up the project ─────────────────────
log "[Step 7/9] Setting up project directory..."
mkdir -p "${APP_DIR}"
chown "${APP_USER}:${APP_GROUP}" "${APP_DIR}"

if [[ -d "${APP_DIR}/.git" ]]; then
    warn "Repository already cloned. Pulling latest changes..."
    su - "${APP_USER}" -c "cd ${APP_DIR} && git pull origin ${APP_BRANCH}" 2>/dev/null || true
else
    log "  Cloning repository..."
    su - "${APP_USER}" -c "git clone -b ${APP_BRANCH} ${APP_REPO} ${APP_DIR}" 2>/dev/null \
        || warn "Git clone failed (may not be public yet). Assuming files are already in place."
fi

# Install dependencies
log "  Installing Node.js dependencies..."
su - "${APP_USER}" -c "cd ${APP_DIR} && bun install --frozen-lockfile 2>/dev/null || bun install" 2>/dev/null
ok "Dependencies installed"

# ── Step 8: Configure environment ────────────────────────────
log "[Step 8/9] Configuring environment..."
if [[ ! -f "${APP_DIR}/.env" ]]; then
    cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"

    # Generate secrets
    NEXTAUTH_SECRET=$(openssl rand -base64 32)
    API_GATEWAY_SECRET=$(openssl rand -base64 32)
    API_KEY_ENCRYPTION_KEY=$(openssl rand -hex 16)
    CSRF_SECRET=$(openssl rand -base64 32)
    SESSION_ENCRYPTION_KEY=$(openssl rand -hex 16)
    WEBHOOK_SECRET=$(openssl rand -base64 32)
    BACKUP_ENCRYPTION_KEY=$(openssl rand -hex 16)

    # Update .env with generated values
    if [[ "${SKIP_DB}" == "false" && -n "${DB_PASS}" ]]; then
        sed -i "s|CHANGE_ME_STRONG_PASSWORD|${DB_PASS}|g" "${APP_DIR}/.env"
    fi
    sed -i "s|CHANGE_ME_GENERATE_WITH_OPENSSL_RAND_BASE64_32|${NEXTAUTH_SECRET}|g" "${APP_DIR}/.env"
    sed -i "s|CHANGE_ME_API_GATEWAY_HMAC_SECRET|${API_GATEWAY_SECRET}|g" "${APP_DIR}/.env"
    sed -i "s|CHANGE_ME_32_BYTE_ENCRYPTION_KEY|${API_KEY_ENCRYPTION_KEY}|g" "${APP_DIR}/.env"
    sed -i "s|CHANGE_ME_CSRF_SECRET|${CSRF_SECRET}|g" "${APP_DIR}/.env"
    sed -i "s|CHANGE_ME_SESSION_KEY|${SESSION_ENCRYPTION_KEY}|g" "${APP_DIR}/.env"
    sed -i "s|CHANGE_ME_WEBHOOK_HMAC_SECRET|${WEBHOOK_SECRET}|g" "${APP_DIR}/.env"
    sed -i "s|CHANGE_ME_BACKUP_ENCRYPTION_KEY|${BACKUP_ENCRYPTION_KEY}|g" "${APP_DIR}/.env"

    ok ".env created with generated secrets"
    warn "Review and update AUTH_OWNER_PASSWORD in ${APP_DIR}/.env"
else
    warn ".env already exists. Not overwriting."
fi

# ── Step 9: Set permissions and finalize ─────────────────────
log "[Step 9/9] Setting permissions and finalizing..."
chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
chmod 600 "${APP_DIR}/.env"
chmod 750 "${APP_DIR}"

# Set directory ownership for uploads/data
mkdir -p "${APP_DIR}/data" "${APP_DIR}/backups" "${APP_DIR}/logs"
chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}/data" "${APP_DIR}/backups" "${APP_DIR}/logs"
chmod 700 "${APP_DIR}/data" "${APP_DIR}/backups"

# Install systemd service
if [[ -f "${APP_DIR}/deploy/systemd/alolabs-agent-hub.service" ]]; then
    cp "${APP_DIR}/deploy/systemd/alolabs-agent-hub.service" /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable alolabs-agent-hub
    ok "systemd service installed and enabled"
else
    warn "systemd service file not found at deploy/systemd/alolabs-agent-hub.service"
fi

# Configure logrotate for the app
cat > /etc/logrotate.d/alolabs-agent-hub <<'LOGROTATE'
/opt/alolabs/agent-hub/logs/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    copytruncate
    su alohub alohub
}
LOGROTATE

# Configure UFW firewall
log "Configuring UFW firewall..."
ufw allow 22/tcp     comment 'SSH'
ufw allow 80/tcp     comment 'HTTP'
ufw allow 443/tcp    comment 'HTTPS'
ufw --force enable
ok "Firewall configured (SSH, HTTP, HTTPS)"

# ── Done ─────────────────────────────────────────────────────
log ""
log "============================================================"
log "✅ INSTALLATION COMPLETE"
log "============================================================"
log ""
log "Next steps:"
log "  1. Edit configuration:  nano ${APP_DIR}/.env"
log "     - Set AUTH_OWNER_EMAIL and AUTH_OWNER_PASSWORD"
log ""
log "  2. Setup database:"
log "     cd ${APP_DIR} && bun run db:push"
log "     bun run db:seed  (if applicable)"
log ""
log "  3. Build the application:"
log "     cd ${APP_DIR} && bun run build"
log ""
log "  4. Start the service:"
log "     systemctl start alolabs-agent-hub"
log "     systemctl status alolabs-agent-hub"
log ""
log "  5. Setup SSL certificates:"
log "     bash ${APP_DIR}/deploy/nginx/ssl-setup.sh"
log ""
log "  6. Verify everything:"
log "     bash ${APP_DIR}/deploy/scripts/health-check.sh"
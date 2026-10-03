// ============================================================
// ALO Labs AI-EOS — PM2 Ecosystem Configuration
// Cluster mode with daily log rotation and graceful shutdown
// ============================================================

module.exports = {
  apps: [{
    name: 'alo-labs-ai-eos',
    script: 'npm',
    args: 'start',
    cwd: '/opt/alo-labs-ai-eos',
    instances: 'max',
    exec_mode: 'cluster',
    max_memory_restart: '512M',

    // ── Environment ──────────────────────────────────────────────
    env: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3011,
    },

    // ── Log Management (PM2 logrotate) ──────────────────────────
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    error_file: '/opt/alo-labs-ai-eos/logs/error.log',
    out_file: '/opt/alo-labs-ai-eos/logs/out.log',
    merge_logs: true,

    // ── PM2-logrotate config (install: pm2 install pm2-logrotate) ─
    // pm2-conf module settings are set via:
    //   pm2 set pm2-logrotate:max_size 50M
    //   pm2 set pm2-logrotate:retain 30
    //   pm2 set pm2-logrotate:compress true
    //   pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
    //   pm2 set pm2-logrotate:rotateInterval '0 0 * * *'  (daily)

    // ── Process Management ──────────────────────────────────────
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    kill_timeout: 10000,
    wait_ready: true,
    listen_timeout: 15000,

    // ── Graceful Shutdown ───────────────────────────────────────
    // PM2 sends SIGINT by default; the app should handle it:
    //   process.on('SIGINT', () => { /* drain connections, cleanup */ process.exit(0); });
    // This kill_timeout gives the app 10s to shut down gracefully
    // before PM2 forces SIGKILL.
  }],
};

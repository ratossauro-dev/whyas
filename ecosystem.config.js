module.exports = {
    apps: [{
        name: 'whatsapp-bot',
        script: 'server.js',
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: '500M',
        env: {
            NODE_ENV: 'production'
        },
        // Restart policy
        exp_backoff_restart_delay: 100,
        max_restarts: 10,
        min_uptime: '10s',
        // Logs
        error_file: './logs/error.log',
        out_file: './logs/output.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        merge_logs: true
    }]
};

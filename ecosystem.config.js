module.exports = {
  apps: [{
    name: 'seo-crawler',
    script: 'src/server.js',
    instances: 1, // Single instance due to SQLite database
    exec_mode: 'fork',
    
    // Environment variables
    env: {
      NODE_ENV: 'development',
      PORT: 3000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    
    // Logging
    error_file: '/var/log/seo-crawler/error.log',
    out_file: '/var/log/seo-crawler/out.log',
    log_file: '/var/log/seo-crawler/combined.log',
    time: true,
    
    // Auto restart settings
    max_memory_restart: '1G',
    restart_delay: 4000,
    max_restarts: 10,
    min_uptime: '10s',
    
    // Advanced settings
    node_args: '--max-old-space-size=1024',
    
    // Monitoring
    pmx: true,
    
    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 3000
  }]
}
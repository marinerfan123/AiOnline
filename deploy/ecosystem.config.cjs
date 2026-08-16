// deploy/ecosystem.config.cjs — PM2 部署（Phase 0）
// 用法：pm2 start deploy/ecosystem.config.cjs --env production
//
// ⚠️ 必须单实例（instances:1 / fork）：dispatcher 的 RPM 调度状态（每账号每分辨率令牌桶）
// 是进程内内存态，多实例会让同一账号被重复计数 → 实际发量达限额数倍 → 厂商 429 风暴。
// 横向扩展请先把 dispatcher.cjs 的 ACCT 状态迁至 Redis（见 docs/deployment-plan.md §6），
// 届时再放开 instances。单进程对 I/O 密集的生图调度足够（重活在厂商侧）。
module.exports = {
  apps: [
    {
      name: 'ai-image-studio',
      script: 'server/server.js',
      // 单实例：保证 RPM 令牌桶全局唯一、计数正确
      instances: 1,
      exec_mode: 'fork',
      // 单进程内存超 1G 自动重启，避免内存泄漏拖垮整机
      max_memory_restart: '1G',
      // 优雅重启：旧进程处理完在途请求再退出
      listen_timeout: 10000,
      kill_timeout: 5000,
      exp_backoff_restart_delay: 100,
      // 生产环境环境变量
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      // 日志
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      // 关键：把未捕获异常写日志而非静默退出
      ignore_watch: ['node_modules', 'dist', 'server/data'],
    },
  ],
};

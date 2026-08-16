import { List, Sparkles, Wrench, Shield } from 'lucide-react';
import { SupportLayout, SupportCard } from './SupportLayout';

const logs = [
  {
    version: 'v0.9.0',
    date: '2026-08-08',
    items: [
      { icon: Wrench, text: '修复服务端 URL 探测误杀导致刷新后图片丢失的问题。', tag: '修复' },
      { icon: Sparkles, text: '支付方式按后台 payment_providers 配置动态显隐。', tag: '新增' },
      { icon: Sparkles, text: '顶部菜单新增帮助中心、使用文档、更新日志、反馈举报等入口。', tag: '新增' },
    ],
  },
  {
    version: 'v0.8.0',
    date: '2026-08-05',
    items: [
      { icon: Sparkles, text: 'Phase A 认证 + 双余额计费正式上线。', tag: '新增' },
      { icon: Sparkles, text: '接入真实易支付通道，支持支付宝/微信支付。', tag: '新增' },
      { icon: Shield, text: '彻底移除 DEV 模拟支付，确保资金安全。', tag: '安全' },
    ],
  },
  {
    version: 'v0.7.0',
    date: '2026-08-03',
    items: [
      { icon: Sparkles, text: '多供应商动态均衡与等待区机制。', tag: '新增' },
      { icon: Sparkles, text: '双边账务看板（后台量 vs 客户量 = 盈亏）。', tag: '新增' },
      { icon: Wrench, text: 'OSS 直传签名，业务服务器零字节中转。', tag: '优化' },
    ],
  },
];

export default function ChangelogPage() {
  return (
    <SupportLayout title="更新日志" subtitle="查看所有产品更新">
      <div className="relative space-y-6 pl-4">
        <div className="absolute left-[1.25rem] top-3 bottom-3 w-px bg-zinc-800" />
        {logs.map((log) => (
          <div key={log.version} className="relative pl-8">
            <div className="absolute left-0 top-0 flex size-6 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900">
              <List className="size-3 text-emerald-400" />
            </div>
            <SupportCard title={`${log.version} · ${log.date}`}>
              <div className="space-y-3">
                {log.items.map((item, i) => {
                  const Icon = item.icon;
                  return (
                    <div key={i} className="flex items-start gap-3">
                      <span className="mt-0.5 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                        {item.tag}
                      </span>
                      <div className="flex items-start gap-2">
                        <Icon className="mt-0.5 size-4 shrink-0 text-zinc-500" />
                        <span className="text-sm text-zinc-400">{item.text}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </SupportCard>
          </div>
        ))}
      </div>
    </SupportLayout>
  );
}

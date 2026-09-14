// 全局监控独立视图（跳出后台 layout，全屏查看单 tab 数据）
// 路由：/monitoring/generations | /monitoring/assets | /monitoring/issues
import { useParams } from 'react-router-dom';
import { X, Database, Activity, Image as ImageIcon, AlertTriangle } from 'lucide-react';
import { GenerationsTab, AssetsTab, IssuesTab } from './MonitoringPage';

const titles: Record<string, { label: string; icon: React.ReactNode }> = {
  generations: { label: '用户生成监控', icon: <Activity className="size-4" /> },
  assets: { label: '资产链接监控', icon: <ImageIcon className="size-4" /> },
  issues: { label: '生成报错监控', icon: <AlertTriangle className="size-4" /> },
};

export default function MonitoringStandalonePage() {
  const { tab } = useParams<{ tab: string }>();
  const meta = titles[tab || ''] || titles.generations;

  return (
    <div className="h-screen w-full bg-black text-white flex flex-col overflow-hidden">
      <header className="shrink-0 flex items-center justify-between gap-4 border-b border-zinc-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20">
            <Database className="size-4" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-white flex items-center gap-2">
              {meta.icon}
              {meta.label}
            </h1>
            <p className="text-xs text-zinc-500">全局监控 · 独立视图 · 仅管理员可见</p>
          </div>
        </div>
        <button
          onClick={() => window.close()}
          className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
        >
          <X className="size-3.5" />
          关闭窗口
        </button>
      </header>

      <main className="flex-1 min-h-0 p-6">
        {tab === 'assets' ? <AssetsTab /> : tab === 'issues' ? <IssuesTab /> : <GenerationsTab />}
      </main>
    </div>
  );
}

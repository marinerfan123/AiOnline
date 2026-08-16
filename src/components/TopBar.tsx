import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  HelpCircle,
  Settings,
  MoreVertical,
  Download,
  ExternalLink,
  Info,
  Play,
  MessageSquareWarning,
  Flag,
  ShieldCheck,
  List,
  User,
  MonitorPlay,
  LogIn,
  LogOut,
  RefreshCw,
  Wallet,
  ChevronDown,
  Loader2,
} from 'lucide-react';
import { useAuth, logout, setAuthModalOpen, refreshUser } from '@/services/authStore';
import { apiExportMyMedia } from '@/services/api';
import { formatCredits } from '@/utils/format';

interface TopBarProps {
  onSettingsOpen: () => void;
  onMediaPickerOpen: () => void;
}

export default function TopBar({ onSettingsOpen, onMediaPickerOpen }: TopBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();

  async function handleDownloadProject() {
    if (!user) return;
    setDownloading(true);
    try {
      const r = await apiExportMyMedia();
      if (r.ok && r.url) {
        const a = document.createElement('a');
        a.href = r.url;
        a.download = r.filename || `moling-export-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else {
        alert(r.error || '导出失败');
      }
    } catch (e: any) {
      alert(e?.message || '导出失败');
    } finally {
      setDownloading(false);
      setMoreOpen(false);
    }
  }

  const moreItems = [
    { icon: Download, label: '下载项目', onClick: handleDownloadProject, loading: downloading },
    { icon: ExternalLink, label: '帮助中心', path: '/help' },
    { icon: HelpCircle, label: '使用文档', path: '/docs' },
    { icon: List, label: '查看所有更新日志', path: '/changelog' },
    { icon: MonitorPlay, label: '视频教程', path: '/tutorials' },
    { icon: Info, label: '关于我们', path: '/about' },
    { icon: Play, label: '新手指南', path: '/guide' },
    { icon: MessageSquareWarning, label: '发送应用反馈', path: '/feedback' },
    { icon: Flag, label: '举报法律问题', path: '/report' },
    { icon: ShieldCheck, label: '隐私声明', path: '/privacy' },
  ];

  const toolButton =
    'flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-white transition-colors';

  return (
    <header className="flex h-14 items-center justify-between px-4 border-b border-zinc-800 bg-black/80 backdrop-blur-md z-20 sticky top-0">
      <div className="flex-1" />

      <div className="flex items-center gap-3">
        {/* 工具图标组 */}
        <div className="flex items-center gap-0.5 rounded-full border border-white/5 bg-white/[0.03] p-1">
          <button onClick={onMediaPickerOpen} className={toolButton} title="新建">
            <Plus className="size-4" />
          </button>
          <button className={toolButton} title="帮助">
            <HelpCircle className="size-4" />
          </button>
          <button onClick={onSettingsOpen} className={toolButton} title="设置">
            <Settings className="size-4" />
          </button>
          <div className="relative">
            <button onClick={() => setMoreOpen(!moreOpen)} className={toolButton} title="更多">
              <MoreVertical className="size-4" />
            </button>
            {moreOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-1.5 w-56 rounded-[1.25rem] bg-zinc-900 p-2 border border-zinc-800 shadow-2xl">
                  {moreItems.map((item) => {
                    const Icon = item.icon;
                    const content = (
                      <>
                        {item.loading ? <Loader2 className="size-4 animate-spin text-zinc-500" /> : <Icon className="size-4 text-zinc-500" />}
                        <span>{item.label}</span>
                      </>
                    );
                    const className = "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-white hover:bg-zinc-800/70 transition-colors disabled:opacity-50";
                    const handleClick = () => {
                      if (item.onClick) item.onClick();
                      else if (item.path) { setMoreOpen(false); navigate(item.path); }
                    };
                    return (
                      <button
                        key={item.label}
                        onClick={handleClick}
                        disabled={item.loading}
                        className={className}
                      >
                        {content}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="hidden sm:block h-6 w-px bg-white/10" />

        {user ? (
          <div className="flex items-center gap-2">
            {/* 双池余额：赠送（平台赠送，限定模型优先扣）+ 充值（真钱，全部可用） */}
            <button
              onClick={() => navigate('/recharge')}
              className="flex h-8 items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 text-xs font-semibold hover:bg-amber-500/20 transition-colors"
              title="赠送余额（平台赠送/活动发放，限定模型可用，优先扣减）· 充值余额（真钱充值，全部模型可用）。点击充值"
            >
              <Wallet className="size-3.5 text-amber-300" />
              <span className="text-emerald-300 tabular-nums" title="赠送余额">{formatCredits(user.rewardCredits)}</span>
              <span className="text-zinc-500">/</span>
              <span className="text-amber-300 tabular-nums" title="充值余额">{formatCredits(user.rechargeCredits)}</span>
            </button>

            {/* 头像菜单 */}
            <div className="relative">
              <button
                onClick={() => setMenuOpen(!menuOpen)}
                className="group flex h-8 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 py-1 pl-1 pr-2 hover:border-white/20 hover:bg-white/10 transition-all"
                title="账户"
              >
                <span className="relative flex size-6 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 via-cyan-400 to-violet-400 text-[11px] font-bold text-black shadow-inner">
                  {(user.displayName || user.email || 'U')[0]?.toUpperCase() || 'U'}
                  <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-emerald-400 ring-2 ring-black" />
                </span>
                <ChevronDown
                  className={`size-3.5 text-zinc-500 transition-transform duration-200 group-hover:text-zinc-300 ${menuOpen ? 'rotate-180' : ''}`}
                />
              </button>

              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-3xl border border-white/10 bg-zinc-900/80 p-0 shadow-2xl backdrop-blur-2xl">
                    <div className="relative px-5 pb-4 pt-5">
                      <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/15 via-cyan-500/10 to-violet-500/15" />
                      <div className="relative flex items-center gap-3">
                        <span className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 via-cyan-400 to-violet-400 text-lg font-bold text-black shadow-lg">
                          {(user.displayName || user.email || 'U')[0]?.toUpperCase() || 'U'}
                        </span>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-white">{user.displayName || '未命名用户'}</div>
                          <div className="truncate text-xs text-zinc-400">{user.email}</div>
                        </div>
                      </div>
                      <div className="relative mt-4 flex items-end justify-between">
                        <div>
                          <div className="text-[11px] text-zinc-500">账户余额</div>
                          <div className="flex items-baseline gap-2 text-2xl font-bold tabular-nums text-white">
                            <span className="text-emerald-400" title="赠送余额">{formatCredits(user.rewardCredits)}</span>
                            <span className="text-zinc-600">/</span>
                            <span className="text-amber-400" title="充值余额">{formatCredits(user.rechargeCredits)}</span>
                          </div>
                          <div className="mt-0.5 text-[10px] text-zinc-500">赠送 · 充值</div>
                        </div>
                        <button
                          onClick={() => { setMenuOpen(false); navigate('/recharge'); }}
                          className="flex items-center gap-1.5 rounded-full bg-emerald-400 px-3 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-emerald-300"
                        >
                          <Wallet className="size-3.5" /> 充值
                        </button>
                      </div>
                    </div>
                    <div className="space-y-0.5 border-t border-white/5 p-2">
                      <button
                        onClick={async () => { await refreshUser().catch(() => {}); }}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-white/10"
                      >
                        <RefreshCw className="size-4 text-zinc-500" /> 刷新积分
                      </button>
                      <button
                        onClick={() => { setMenuOpen(false); navigate('/account'); }}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-white/10"
                      >
                        <Settings className="size-4 text-zinc-500" /> 账户设置
                      </button>
                      <button
                        onClick={() => { setMenuOpen(false); navigate(`/user/${user.id}`); }}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-zinc-300 transition-colors hover:bg-white/10"
                      >
                        <User className="size-4 text-zinc-500" /> 我的主页
                      </button>
                      <button
                        onClick={async () => { await logout(); setMenuOpen(false); }}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-red-400 transition-colors hover:bg-red-500/10"
                      >
                        <LogOut className="size-4" /> 退出登录
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          <button
            onClick={() => setAuthModalOpen(true)}
            className="flex h-8 items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/20 transition-colors"
          >
            <LogIn className="size-3.5" /> 登录
          </button>
        )}
      </div>

    </header>
  );
}

import { useState } from 'react';
import { toast } from 'sonner';
import { LogIn, UserPlus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { login, register, setAuthModalOpen, useAuth } from '@/services/authStore';

type Tab = 'login' | 'register';

export default function AuthModal() {
  const { modalOpen } = useAuth();
  const [tab, setTab] = useState<Tab>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);

  const close = () => setAuthModalOpen(false);

  const submit = async () => {
    if (!email.trim() || !password) {
      toast.error('请填写邮箱和密码');
      return;
    }
    if (tab === 'register' && password.length < 6) {
      toast.error('密码至少 6 位');
      return;
    }
    setLoading(true);
    try {
      if (tab === 'login') {
        await login(email.trim(), password);
        toast.success('登录成功');
      } else {
        await register(email.trim(), password, displayName.trim() || undefined);
        toast.success('注册成功，已赠送 50 积分', { duration: 3000 });
      }
      setEmail('');
      setPassword('');
      setDisplayName('');
      close();
    } catch (e) {
      const msg: string = (e instanceof Error ? e.message : String(e)) || '';
      if (msg.includes('409')) toast.error('该邮箱已注册，请直接登录');
      else if (msg.includes('401')) toast.error('邮箱或密码错误');
      else if (msg.includes('400')) toast.error('请检查邮箱格式与密码长度');
      else toast.error(msg.slice(0, 120) || '操作失败');
    } finally {
      setLoading(false);
    }
  };

  const inputCls =
    'w-full rounded-xl bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder:text-zinc-600 border border-zinc-700 focus:outline-none focus:border-emerald-500/50 transition-colors';

  return (
    <Dialog open={modalOpen} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-sm bg-zinc-900 border-zinc-800">
        <DialogHeader>
          <DialogTitle className="text-white">
            {tab === 'login' ? '登录' : '注册'}
          </DialogTitle>
          <DialogDescription className="text-zinc-500">
            登录后生成将计入你的积分账户；新用户注册赠送 50 积分。
          </DialogDescription>
        </DialogHeader>

        <div className="mt-3 space-y-3">
          {/* Tab 切换 */}
          <div className="flex rounded-full bg-zinc-800/50 p-0.5 text-xs">
            {(['login', 'register'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-1.5 font-medium transition-all ${
                  tab === t ? 'bg-zinc-900 text-emerald-400 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {t === 'login' ? <LogIn className="size-3.5" /> : <UserPlus className="size-3.5" />}
                {t === 'login' ? '登录' : '注册'}
              </button>
            ))}
          </div>

          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="邮箱"
            type="email"
            autoComplete="email"
            className={inputCls}
          />
          {tab === 'register' && (
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="昵称（可选）"
              className={inputCls}
            />
          )}
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码（至少 6 位）"
            type="password"
            autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
            className={inputCls}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />

          <button
            disabled={loading}
            onClick={() => void submit()}
            className="w-full rounded-full bg-emerald-500 py-2.5 text-sm font-bold text-black shadow-lg shadow-emerald-500/20 hover:bg-emerald-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 transition-all"
          >
            {loading ? '处理中…' : tab === 'login' ? '登录' : '注册并领取 50 积分'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

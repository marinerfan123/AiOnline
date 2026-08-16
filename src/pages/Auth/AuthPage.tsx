// 登录 / 注册页（独立路由 /login /register，Phase 1）
// 复用 authStore（httpOnly cookie 会话 + JWT）；与 AuthModal 共享同一套登录逻辑。
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { Sparkles, Mail, Lock, User as UserIcon, ArrowLeft } from 'lucide-react';
import { login, register } from '@/services/authStore';

export default function AuthPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const initialMode = params.get('mode') === 'register' ? 'register' : 'login';
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const from = (location.state as { from?: string } | null)?.from ?? '/';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!email || !password) {
      setError('请输入邮箱与密码');
      return;
    }
    setLoading(true);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await register(email, password, displayName || undefined);
      }
      navigate(from, { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '操作失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-black p-5">
      <div className="w-full max-w-sm">
        <button
          onClick={() => navigate('/')}
          className="mb-6 flex items-center gap-1.5 text-sm text-zinc-500 hover:text-white transition-colors"
        >
          <ArrowLeft className="size-4" /> 返回首页
        </button>

        <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-7 backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <div className="flex size-10 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20">
              <Sparkles className="size-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-white">
                {mode === 'login' ? '登录' : '注册'}
              </h1>
              <p className="text-xs text-zinc-500">墨灵AI 账号</p>
            </div>
          </div>

          <form onSubmit={submit} className="mt-6 space-y-3">
            {mode === 'register' && (
              <Field icon={<UserIcon className="size-4" />} placeholder="昵称（可选）" value={displayName} onChange={setDisplayName} />
            )}
            <Field icon={<Mail className="size-4" />} type="email" placeholder="邮箱" value={email} onChange={setEmail} />
            <Field icon={<Lock className="size-4" />} type="password" placeholder="密码" value={password} onChange={setPassword} />

            {error && <p className="text-xs text-red-400">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-2xl bg-emerald-500 py-2.5 text-sm font-medium text-black transition-colors hover:bg-emerald-400 disabled:opacity-60"
            >
              {loading ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
            </button>
          </form>

          <p className="mt-4 text-center text-xs text-zinc-500">
            {mode === 'login' ? '还没有账号？' : '已有账号？'}{' '}
            <button
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError('');
              }}
              className="text-emerald-400 hover:underline"
            >
              {mode === 'login' ? '去注册' : '去登录'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}

function Field({
  icon,
  type = 'text',
  placeholder,
  value,
  onChange,
}: {
  icon: ReactNode;
  type?: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500">
        {icon}
      </span>
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 pl-9 pr-3 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none transition-colors"
      />
    </div>
  );
}

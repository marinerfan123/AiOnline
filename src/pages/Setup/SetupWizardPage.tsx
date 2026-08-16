// 首次部署初始化向导（独立全屏路由 /setup，不走前台壳）
// 范围：管理员账号 + 可选服务商 + 常用图像模型勾选；数据库由部署者经 .env 预先配好（本地/远程皆可）。
// 安全：后端 fails-closed —— 首个管理员建好后 /api/setup/init 返回 409，任何人无法重复初始化。
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles, Mail, Lock, User as UserIcon, Key, Server, Database, Check,
  ChevronRight, ChevronLeft, Loader2, AlertTriangle, ArrowRight,
} from 'lucide-react';
import { getSetupStatus, postSetupInit, type ISetupModelPreset } from '@/services/api';
import { LiquidGlass, BlurText, FadeIn } from '@/components/premium';

type Step = 'loading' | 'intro' | 'admin' | 'provider' | 'done' | 'already';

const STEP_ORDER: Exclude<Step, 'loading' | 'already'>[] = ['intro', 'admin', 'provider', 'done'];

export default function SetupWizardPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('loading');
  const [presetModels, setPresetModels] = useState<ISetupModelPreset[]>([]);

  // 表单状态
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminDisplayName, setAdminDisplayName] = useState('');
  const [configureProvider, setConfigureProvider] = useState(true);
  const [providerName, setProviderName] = useState('');
  const [providerBaseUrl, setProviderBaseUrl] = useState('https://api.openai.com/v1');
  const [providerApiKey, setProviderApiKey] = useState('');
  const [providerProtocol, setProviderProtocol] = useState('openai-compatible');
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ providerCreated: boolean; modelsEnabled: number } | null>(null);

  // 挂载即探测初始化状态
  useEffect(() => {
    getSetupStatus()
      .then((s) => {
        setPresetModels(s.presetModels || []);
        if (s.initialized) setStep('already');
        else setStep('intro');
      })
      .catch(() => setStep('intro')); // 探测失败也放行到向导（后端会最终裁决）
  }, []);

  const stepIndex = STEP_ORDER.indexOf(step as any);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
      setError('请输入有效的管理员邮箱');
      return;
    }
    if (adminPassword.length < 8) {
      setError('管理员密码至少 8 位');
      return;
    }
    if (selectedModelIds.length > 0 && !providerApiKey.trim()) {
      setError('启用模型前请先填写服务商 API Key');
      return;
    }
    setSubmitting(true);
    try {
      const data = await postSetupInit({
        adminEmail,
        adminPassword,
        adminDisplayName: adminDisplayName.trim() || undefined,
        provider: configureProvider && providerApiKey.trim()
          ? {
              name: providerName.trim() || undefined,
              base_url: providerBaseUrl.trim() || undefined,
              api_key: providerApiKey.trim(),
              protocol: providerProtocol.trim() || undefined,
            }
          : null,
        selectedModelIds,
      });
      setResult({ providerCreated: data.providerCreated, modelsEnabled: data.modelsEnabled });
      setStep('done');
    } catch (err: unknown) {
      const e = err as Error & { code?: string };
      if (e.code === 'already_initialized') {
        setStep('already');
        return;
      }
      setError(mapError(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (step === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black">
        <Loader2 className="size-6 animate-spin text-emerald-400" />
      </div>
    );
  }

  if (step === 'already') {
    return (
      <Shell>
        <LiquidGlass strong className="rounded-3xl p-8 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20">
            <Check className="size-6" />
          </div>
          <h1 className="text-xl font-semibold text-white">平台已完成初始化</h1>
          <p className="mt-2 text-sm text-zinc-400">
            首个管理员已存在，初始化向导已锁定。如需新增管理员，请登录后台处理。
          </p>
          <button
            onClick={() => navigate('/login')}
            className="mt-6 inline-flex items-center gap-1.5 rounded-2xl bg-emerald-500 px-5 py-2.5 text-sm font-medium text-black transition-colors hover:bg-emerald-400"
          >
            前往登录 <ArrowRight className="size-4" />
          </button>
        </LiquidGlass>
      </Shell>
    );
  }

  return (
    <Shell>
      {/* 步骤指示 */}
      {step !== 'done' && (
        <Stepper current={stepIndex} />
      )}

      <FadeIn delay={0.1}>
        <LiquidGlass strong className="rounded-3xl p-7">
        {step === 'intro' && (
          <IntroStep
            onNext={() => setStep('admin')}
          />
        )}

        {step === 'admin' && (
          <div>
            <SectionTitle icon={<UserIcon className="size-5" />} title="创建管理员账号" desc="这是平台的第一个账号，拥有后台全部权限。" />
            <div className="mt-6 space-y-3">
              <Field icon={<UserIcon className="size-4" />} placeholder="昵称（可选）" value={adminDisplayName} onChange={setAdminDisplayName} />
              <Field icon={<Mail className="size-4" />} type="email" placeholder="管理员邮箱" value={adminEmail} onChange={setAdminEmail} autoFocus />
              <Field icon={<Lock className="size-4" />} type="password" placeholder="管理员密码（至少 8 位）" value={adminPassword} onChange={setAdminPassword} />
            </div>
            <NavRow onBack={() => setStep('intro')} onNext={() => setStep('provider')} nextLabel="下一步：服务商" />
          </div>
        )}

        {step === 'provider' && (
          <form onSubmit={submit}>
            <SectionTitle icon={<Server className="size-5" />} title="配置服务商与模型" desc="可选。填 API Key 并勾选模型即可立即开画；也可稍后在后台「模型 Hub」配置。" />

            <label className="mt-5 flex cursor-pointer items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3">
              <span className="flex items-center gap-2 text-sm text-zinc-200">
                <Key className="size-4 text-emerald-400" /> 配置服务商（开放 AI 兼容接口）
              </span>
              <input
                type="checkbox"
                checked={configureProvider}
                onChange={(e) => setConfigureProvider(e.target.checked)}
                className="peer sr-only"
              />
              <span className={`relative h-6 w-11 rounded-full transition-colors ${configureProvider ? 'bg-emerald-500' : 'bg-zinc-700'}`}>
                <span className={`absolute top-0.5 size-5 rounded-full bg-white transition-all ${configureProvider ? 'left-[22px]' : 'left-0.5'}`} />
              </span>
            </label>

            {configureProvider && (
              <div className="mt-3 space-y-3">
                <Field icon={<Server className="size-4" />} placeholder="服务商名称（可选，如 My GPU）" value={providerName} onChange={setProviderName} />
                <Field icon={<Database className="size-4" />} placeholder="Base URL" value={providerBaseUrl} onChange={setProviderBaseUrl} />
                <Field icon={<Key className="size-4" />} type="password" placeholder="API Key（必填，仅存于数据库）" value={providerApiKey} onChange={setProviderApiKey} />
                <Field icon={<Server className="size-4" />} placeholder="协议（默认 openai-compatible）" value={providerProtocol} onChange={setProviderProtocol} />
              </div>
            )}

            {presetModels.length > 0 && (
              <div className="mt-5">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">启用以下模型（可选）</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {presetModels.map((m) => {
                    const checked = selectedModelIds.includes(m.id);
                    return (
                      <button
                        type="button"
                        key={m.id}
                        onClick={() =>
                          setSelectedModelIds((prev) =>
                            checked ? prev.filter((x) => x !== m.id) : [...prev, m.id],
                          )
                        }
                        className={`flex items-center gap-3 rounded-2xl border px-3.5 py-3 text-left transition-colors ${
                          checked ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-zinc-800 bg-zinc-950/40 hover:border-zinc-700'
                        }`}
                      >
                        <span className={`flex size-5 shrink-0 items-center justify-center rounded-md border ${checked ? 'border-emerald-400 bg-emerald-500 text-black' : 'border-zinc-600'}`}>
                          {checked && <Check className="size-3.5" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm text-white">{m.displayName}</span>
                          <span className="block truncate text-xs text-zinc-500">{m.modelId}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {error && (
              <p className="mt-4 flex items-center gap-1.5 text-xs text-red-400">
                <AlertTriangle className="size-3.5" /> {error}
              </p>
            )}

            <NavRow
              onBack={() => setStep('admin')}
              submit
              submitting={submitting}
              nextLabel="完成初始化"
            />
          </form>
        )}

        {step === 'done' && (
          <div className="text-center">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20">
              <Check className="size-6" />
            </div>
            <h1 className="text-xl font-semibold text-white">初始化完成 🎉</h1>
            <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-400">
              管理员账号已创建{result?.providerCreated ? '，服务商已接入' : ''}
              {typeof result?.modelsEnabled === 'number' && result.modelsEnabled > 0 ? `，${result.modelsEnabled} 个模型已启用` : ''}。
              现在可以用管理员账号登录了。
            </p>
            <button
              onClick={() => navigate('/login')}
              className="mt-6 inline-flex items-center gap-1.5 rounded-2xl bg-emerald-500 px-5 py-2.5 text-sm font-medium text-black transition-colors hover:bg-emerald-400"
            >
              前往登录 <ArrowRight className="size-4" />
            </button>
          </div>
        )}
        </LiquidGlass>
      </FadeIn>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black p-5">
      <div className="w-full max-w-lg">{children}</div>
    </div>
  );
}

function Stepper({ current }: { current: number }) {
  return (
    <div className="mb-5 flex items-center justify-center gap-2">
      {STEP_ORDER.filter((s) => s !== 'done').map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <div className={`flex size-7 items-center justify-center rounded-full text-xs font-medium transition-colors ${i <= current ? 'bg-emerald-500 text-black' : 'bg-zinc-800 text-zinc-500'}`}>
            {i < current ? <Check className="size-3.5" /> : i + 1}
          </div>
          {i < STEP_ORDER.filter((x) => x !== 'done').length - 1 && (
            <span className={`h-0.5 w-8 rounded ${i < current ? 'bg-emerald-500' : 'bg-zinc-800'}`} />
          )}
        </div>
      ))}
    </div>
  );
}

function SectionTitle({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20">
        {icon}
      </div>
      <div>
        <h1 className="text-lg font-semibold text-white">{title}</h1>
        <p className="mt-0.5 text-xs text-zinc-500">{desc}</p>
      </div>
    </div>
  );
}

function IntroStep({ onNext }: { onNext: () => void }) {
  return (
    <div>
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/20">
          <Sparkles className="size-5" />
        </div>
        <div>
          <BlurText as="h1" text="欢迎初始化平台" className="text-lg font-semibold text-white" style={{ justifyContent: 'flex-start', textAlign: 'left' }} />
          <p className="mt-0.5 text-xs text-zinc-500">首次部署引导 · 约 1 分钟</p>
        </div>
      </div>

      <ul className="mt-6 space-y-3 text-sm text-zinc-300">
        <li className="flex items-start gap-2.5">
          <Database className="mt-0.5 size-4 shrink-0 text-emerald-400" />
          <span>数据库（PostgreSQL / Redis）请在部署时经 <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-emerald-300">.env</code> 配置，本地 Compose 或远程 RDS 皆可。</span>
        </li>
        <li className="flex items-start gap-2.5">
          <UserIcon className="mt-0.5 size-4 shrink-0 text-emerald-400" />
          <span>第一步创建平台管理员账号（拥有全部后台权限）。</span>
        </li>
        <li className="flex items-start gap-2.5">
          <Server className="mt-0.5 size-4 shrink-0 text-emerald-400" />
          <span>第二步可选接入 AI 服务商并勾选模型，完成后立即可以生图。</span>
        </li>
      </ul>

      <button
        onClick={onNext}
        className="mt-7 flex w-full items-center justify-center gap-1.5 rounded-2xl bg-emerald-500 py-2.5 text-sm font-medium text-black transition-colors hover:bg-emerald-400"
      >
        开始初始化 <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

function NavRow({
  onBack,
  onNext,
  submit,
  submitting,
  nextLabel,
}: {
  onBack: () => void;
  onNext?: () => void;
  submit?: boolean;
  submitting?: boolean;
  nextLabel: string;
}) {
  return (
    <div className="mt-7 flex items-center justify-between gap-3">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 rounded-2xl border border-zinc-800 px-4 py-2.5 text-sm text-zinc-400 transition-colors hover:text-white"
      >
        <ChevronLeft className="size-4" /> 上一步
      </button>
      <button
        type={submit ? 'submit' : 'button'}
        disabled={submitting}
        onClick={submit ? undefined : onNext}
        className="flex items-center gap-1.5 rounded-2xl bg-emerald-500 px-5 py-2.5 text-sm font-medium text-black transition-colors hover:bg-emerald-400 disabled:opacity-60"
      >
        {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
        {submitting ? '初始化中…' : nextLabel}
        {!submit && <ChevronRight className="size-4" />}
      </button>
    </div>
  );
}

function Field({
  icon,
  type = 'text',
  placeholder,
  value,
  onChange,
  autoFocus,
}: {
  icon: ReactNode;
  type?: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
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
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-2xl border border-zinc-800 bg-zinc-950 pl-9 pr-3 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none transition-colors"
      />
    </div>
  );
}

function mapError(e: Error & { code?: string }): string {
  switch (e.code) {
    case 'invalid_email': return '请输入有效的管理员邮箱';
    case 'weak_password': return '管理员密码至少 8 位';
    case 'provider_required': return '启用模型前请先填写服务商 API Key';
    case 'already_initialized': return '平台已完成初始化';
    case 'no_db': return '数据库未连接，请先配置并启动数据库';
    case 'too_many_attempts': return '尝试过于频繁，请稍后再试';
    case 'setup_failed': return `初始化失败：${e.message || '未知错误'}`;
    default: return e.message || '初始化失败，请重试';
  }
}

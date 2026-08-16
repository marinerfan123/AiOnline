import { Info, Target, Zap, Heart, Mail } from 'lucide-react';
import { SupportLayout, SupportCard } from './SupportLayout';

export default function AboutPage() {
  return (
    <SupportLayout title="关于我们" subtitle="墨灵AI 的使命与团队">
      <SupportCard>
        <div className="flex items-center gap-4">
            <div className="flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-cyan-400 text-2xl font-bold text-black">
              墨
            </div>
          <div>
            <h2 className="text-lg font-semibold text-white">墨灵AI</h2>
            <p className="text-sm text-zinc-500">AI 驱动的视觉创作平台</p>
          </div>
        </div>
        <p className="mt-5 text-sm leading-relaxed text-zinc-400">
          墨灵AI 致力于让每个人都能用自然语言创作高质量的图像与视频。我们相信，AI 不是替代创作者，而是放大创意的工具。
          从灵感闪现到成品输出，我们提供一站式创作工作台、模型 Hub、AI 市集与创作工作室，帮助创作者把想法快速落地。
        </p>
      </SupportCard>

      <div className="grid gap-5 sm:grid-cols-3">
        <SupportCard title="愿景">
          <div className="flex items-start gap-3">
            <Target className="size-5 shrink-0 text-emerald-400" />
            <p className="text-sm leading-relaxed text-zinc-400">
              成为最懂创作者的一站式 AI 视觉创作基础设施。
            </p>
          </div>
        </SupportCard>
        <SupportCard title="技术">
          <div className="flex items-start gap-3">
            <Zap className="size-5 shrink-0 text-emerald-400" />
            <p className="text-sm leading-relaxed text-zinc-400">
              多供应商动态调度、双余额计费、OSS 直传，保障稳定与成本可控。
            </p>
          </div>
        </SupportCard>
        <SupportCard title="社区">
          <div className="flex items-start gap-3">
            <Heart className="size-5 shrink-0 text-emerald-400" />
            <p className="text-sm leading-relaxed text-zinc-400">
              创作者主页、AI 市集、示例库，让优秀作品被更多人看见。
            </p>
          </div>
        </SupportCard>
      </div>

      <SupportCard title="联系我们">
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Mail className="size-4 text-emerald-400" />
          商务与合作：
          <a href="mailto:hello@moling.ai" className="text-emerald-400 hover:underline">
            hello@moling.ai
          </a>
        </div>
      </SupportCard>
    </SupportLayout>
  );
}

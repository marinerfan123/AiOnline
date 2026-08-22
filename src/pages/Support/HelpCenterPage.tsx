import { HelpCircle, Search, MessageSquare, BookOpen, Video, Shield } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { SupportLayout, SupportCard } from './SupportLayout';

const faqs = [
  {
    q: '如何开始生成第一张图？',
    a: '进入「工作台」，在底部输入框写下你的创意描述，选择模型与比例，点击生成即可。新用户注册即赠送积分。',
  },
  {
    q: '赠送积分和充值积分有什么区别？',
    a: '赠送积分是平台赠送/活动发放，仅支持赠送余额的模型可用，优先扣减；充值积分是真钱充值，全部模型可用。',
  },
  {
    q: '生成失败会扣积分吗？',
    a: '不会。生成失败会触发自动回退，已预扣的积分会原路返还到你的账户。',
  },
  {
    q: '可以商用生成的作品吗？',
    a: '取决于你使用的模型。部分模型支持商业用途，请在「模型 Hub」查看具体模型的 commercialUse 标识。',
  },
];

const quickLinks = [
  { label: '使用文档', path: '/docs', icon: BookOpen },
  { label: '新手指南', path: '/guide', icon: HelpCircle },
  { label: '视频教程', path: '/tutorials', icon: Video },
  { label: '隐私声明', path: '/privacy', icon: Shield },
];

export default function HelpCenterPage() {
  return (
    <SupportLayout title="帮助中心" subtitle="常见问题与快速入口">
      <SupportCard>
        <div className="grid gap-4 sm:grid-cols-2">
          {quickLinks.map((l) => {
            const Icon = l.icon;
            return (
              <a
                key={l.path}
                href={l.path}
                className="group flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-950/40 p-4 transition-all hover:border-emerald-500/30 hover:bg-white/[0.02]"
              >
                <div className="flex size-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400">
                  <Icon className="size-5" />
                </div>
                <span className="text-sm font-medium text-zinc-200 group-hover:text-white">{l.label}</span>
              </a>
            );
          })}
        </div>
      </SupportCard>

      <SupportCard title="常见问题">
        <div className="space-y-4">
          {faqs.map((f, i) => (
            <div key={i} className="rounded-2xl border border-zinc-800/60 bg-zinc-950/30 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-emerald-300">
                <Search className="size-4" />
                {f.q}
              </div>
              <p className="text-sm leading-relaxed text-zinc-400">{f.a}</p>
            </div>
          ))}
        </div>
      </SupportCard>

      <SupportCard title="没找到答案？">
        <p className="mb-4 text-sm text-zinc-400">
          你可以通过「发送应用反馈」向我们提问，或查看使用文档了解更多细节。
        </p>
        <NavLink
          to="/feedback"
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-emerald-400"
        >
          <MessageSquare className="size-4" /> 发送反馈
        </NavLink>
      </SupportCard>
    </SupportLayout>
  );
}

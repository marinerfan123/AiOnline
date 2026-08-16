import { Play, Wand2, Image, FolderOpen, ShoppingBag, User } from 'lucide-react';
import { SupportLayout, SupportCard } from './SupportLayout';

const steps = [
  {
    step: 1,
    icon: Wand2,
    title: '写下你的创意',
    desc: '在工作台底部的输入框里描述你想生成的画面。可以是简单的一句话，也可以是详细的主体、场景、风格、光照描述。',
  },
  {
    step: 2,
    icon: Image,
    title: '选择模型与比例',
    desc: '根据你想生成的类型（图片/视频）选择合适的模型，并设置画面比例。不同模型擅长不同风格，多试几次会有惊喜。',
  },
  {
    step: 3,
    icon: Play,
    title: '点击生成',
    desc: '系统会预先扣除积分并开始生成。生成过程中可以去素材库查看进度，刷新页面也不会丢失任务。',
  },
  {
    step: 4,
    icon: FolderOpen,
    title: '管理与复用',
    desc: '生成完成的作品会进入素材库。你可以收藏、删除、下载项目，也可以点击「生成变体」或「使用此配方创作」。',
  },
  {
    step: 5,
    icon: ShoppingBag,
    title: '探索 AI 市集',
    desc: '在市集中发现技能包、创作者模板与数字作品，也可以将自己的作品上架。',
  },
  {
    step: 6,
    icon: User,
    title: '分享主页',
    desc: '每位用户都有独立的公开主页。把 /user/:id 分享给朋友，让他们看到你的作品集。',
  },
];

export default function GuidePage() {
  return (
    <SupportLayout title="新手指南" subtitle="6 步开启你的 AI 创作之旅">
      <div className="relative space-y-5 pl-4">
        <div className="absolute left-[1.25rem] top-4 bottom-4 w-px bg-zinc-800" />
        {steps.map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.step} className="relative pl-8">
              <div className="absolute left-0 top-0 flex size-6 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-black">
                {s.step}
              </div>
              <SupportCard title={s.title}>
                <div className="flex items-start gap-3">
                  <Icon className="mt-0.5 size-5 shrink-0 text-emerald-400" />
                  <p className="text-sm leading-relaxed text-zinc-400">{s.desc}</p>
                </div>
              </SupportCard>
            </div>
          );
        })}
      </div>
    </SupportLayout>
  );
}

import { MonitorPlay, Play, Clock, BookOpen } from 'lucide-react';
import { SupportLayout, SupportCard } from './SupportLayout';

const tutorials = [
  {
    title: '5 分钟上手墨灵AI',
    duration: '05:20',
    desc: '从注册、生成第一张图到管理素材库，完整走一遍核心流程。',
  },
  {
    title: '提示词优化指南',
    duration: '08:45',
    desc: '如何写出结构清晰、效果稳定的图像/视频生成提示词。',
  },
  {
    title: '角色一致性实战',
    duration: '12:10',
    desc: '使用角色库与参考图，让同一个人物出现在多个场景。',
  },
  {
    title: '创作工作室：从脚本到分镜',
    duration: '15:30',
    desc: '用项目流水线组织复杂创作，批量产出统一风格的分镜。',
  },
];

export default function TutorialsPage() {
  return (
    <SupportLayout title="视频教程" subtitle="跟着视频快速掌握墨灵AI">
      <div className="grid gap-5 sm:grid-cols-2">
        {tutorials.map((t) => (
          <SupportCard key={t.title}>
            <div className="group relative mb-4 aspect-video overflow-hidden rounded-2xl bg-zinc-950">
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex size-14 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30 transition-transform group-hover:scale-110">
                  <Play className="size-6 fill-current" />
                </div>
              </div>
              <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                <Clock className="size-3" />
                {t.duration}
              </div>
            </div>
            <h3 className="mb-1 text-sm font-semibold text-zinc-200">{t.title}</h3>
            <p className="text-xs leading-relaxed text-zinc-500">{t.desc}</p>
          </SupportCard>
        ))}
      </div>

      <SupportCard>
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <MonitorPlay className="size-8 text-zinc-600" />
          <p className="text-sm text-zinc-400">
            更多视频教程正在制作中。你也可以查看
            <a href="/docs" className="mx-1 text-emerald-400 hover:underline">使用文档</a>
            获取图文版说明。
          </p>
        </div>
      </SupportCard>
    </SupportLayout>
  );
}

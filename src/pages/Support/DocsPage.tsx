import { BookOpen, Wand2, Image, Video, Wallet, Users, ShieldCheck } from 'lucide-react';
import { SupportLayout, SupportCard } from './SupportLayout';

const sections = [
  {
    icon: Wand2,
    title: '生成图片 / 视频',
    items: [
      '在「工作台」输入创意描述（prompt），支持中文。',
      '选择模型、比例与画质，点击生成。',
      '一次可生成多张，结果会实时出现在素材库。',
      '支持上传参考图进行 Remix 或风格迁移。',
    ],
  },
  {
    icon: Image,
    title: '素材库管理',
    items: [
      '所有生成/上传的作品自动归类到素材库。',
      '支持按图片、视频、角色、场景、道具筛选。',
      '可收藏、删除或批量下载项目。',
      '默认示例图仅作参考，可复制配方一键创作。',
    ],
  },
  {
    icon: Video,
    title: '创作工作室',
    items: [
      '创建项目，按流水线阶段组织分镜与资产。',
      '绑定角色设定，保持形象一致性。',
      '批量生成场景，快速完成视频/漫画预演。',
    ],
  },
  {
    icon: Wallet,
    title: '积分与充值',
    items: [
      '注册即赠送积分。',
      '充值余额为真钱充值，所有模型通用。',
      '生成按模型单价扣费，失败自动回退。',
      '在「账户设置」查看流水与订单。',
    ],
  },
  {
    icon: Users,
    title: '创作者主页',
    items: [
      '每位用户拥有公开主页 /user/:id。',
      '可分享个人作品集，无需登录即可浏览。',
      '主页内容仅展示你未删除的公开素材。',
    ],
  },
  {
    icon: ShieldCheck,
    title: '安全与合规',
    items: [
      '禁止生成违法、侵权或有害内容。',
      '发现违规可通过「举报法律问题」入口反馈。',
      '平台保留对违规账号进行限制或封禁的权利。',
    ],
  },
];

export default function DocsPage() {
  return (
    <SupportLayout title="使用文档" subtitle="墨灵AI 核心功能指南">
      {sections.map((s) => {
        const Icon = s.icon;
        return (
          <SupportCard key={s.title} title={s.title}>
            <div className="flex items-start gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400">
                <Icon className="size-4" />
              </div>
              <ul className="flex-1 list-disc space-y-2 pl-4 text-sm leading-relaxed text-zinc-400 marker:text-zinc-600">
                {s.items.map((it, i) => (
                  <li key={i}>{it}</li>
                ))}
              </ul>
            </div>
          </SupportCard>
        );
      })}

      <SupportCard>
        <div className="flex items-center gap-3 text-sm text-zinc-500">
          <BookOpen className="size-4 text-emerald-400" />
          文档会持续更新，如遇功能变动以实际界面为准。
        </div>
      </SupportCard>
    </SupportLayout>
  );
}

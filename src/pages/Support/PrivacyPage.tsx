import { ShieldCheck } from 'lucide-react';
import { SupportLayout, SupportCard } from './SupportLayout';

export default function PrivacyPage() {
  return (
    <SupportLayout title="隐私声明" subtitle="我们如何保护你的数据">
      <SupportCard>
        <div className="flex items-center gap-3">
          <ShieldCheck className="size-6 text-emerald-400" />
          <h2 className="text-sm font-semibold text-zinc-200">数据最小化原则</h2>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400">
          我们仅收集运行服务所必需的信息：账户信息、创作素材、积分流水与支付订单。
          生成提示词、参考图与最终作品默认归你所有，我们不会将个人隐私数据出售或提供给第三方广告商。
        </p>
      </SupportCard>

      <SupportCard title="我们收集的信息">
        <ul className="list-disc space-y-2 pl-4 text-sm leading-relaxed text-zinc-400 marker:text-zinc-600">
          <li>账户信息：邮箱、昵称、密码哈希。</li>
          <li>创作数据：提示词、生成的图片/视频、素材分类。</li>
          <li>交易数据：充值订单、积分流水、支付渠道信息。</li>
          <li>技术数据：IP、浏览器类型、操作日志（用于安全审计与限流）。</li>
        </ul>
      </SupportCard>

      <SupportCard title="我们如何使用信息">
        <ul className="list-disc space-y-2 pl-4 text-sm leading-relaxed text-zinc-400 marker:text-zinc-600">
          <li>提供生成、存储、展示、下载等核心服务。</li>
          <li>防止滥用、欺诈与违规内容生成。</li>
          <li>优化模型调度与平台稳定性。</li>
          <li>向你发送服务通知与账单信息。</li>
        </ul>
      </SupportCard>

      <SupportCard title="数据安全">
        <p className="text-sm leading-relaxed text-zinc-400">
          密码采用加盐哈希存储；真实文件不经过业务服务器中转，直接通过 OSS 预签名 URL 上传/下载；
          支付信息由持牌支付服务商处理，平台不保存敏感密钥明文。我们会定期进行安全审计与备份。
        </p>
      </SupportCard>

      <SupportCard title="联系我们">
        <p className="text-sm leading-relaxed text-zinc-400">
          如有关于隐私的疑问，请通过「发送应用反馈」或发送邮件至
          <a href="mailto:privacy@moling.ai" className="mx-1 text-emerald-400 hover:underline">privacy@moling.ai</a>
          与我们联系。
        </p>
      </SupportCard>
    </SupportLayout>
  );
}

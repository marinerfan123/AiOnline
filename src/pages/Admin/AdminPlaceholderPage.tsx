// 后台模块占位页（建设中）
// 承接模块注册表中 comingSoon 的入口：路由已通、点击不 404，展示规划说明，
// 待对应分期路线接入真实功能与后端数据后替换为本页面。
import { PageHeader, SectionCard, Placeholder } from '@/components/skeleton';

interface Props {
  title: string;
  note?: string;
}

export default function AdminPlaceholderPage({ title, note }: Props) {
  return (
    <div className="space-y-6 p-6">
      <PageHeader title={title} subtitle="模块规划中 · 已在后台模块注册表登记" />
      <SectionCard title="规划说明">
        <Placeholder
          label={`${title}模块正在建设`}
          note={note ?? '该模块已在后台模块注册表中登记，后续按分期路线接入真实功能与后端数据。'}
          height="h-56"
        />
      </SectionCard>
    </div>
  );
}

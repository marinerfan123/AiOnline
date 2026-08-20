// 电商后台（骨架，M6 电商模块 / Phase 5 /admin/ecommerce）
// 店铺 / 商品 / SKU / 订单 / 优惠券 / 评价 / 物流 管理。
import { Store } from 'lucide-react';
import { PageHeader, SectionCard, Placeholder, TabBar } from '@/components/skeleton';
import { useState } from 'react';

export default function EcommerceAdminPage() {
  const [tab, setTab] = useState<'shops' | 'products' | 'orders' | 'coupons'>('products');

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="电商后台"
        subtitle="M6 · shops / products / product_skus / orders / coupons / reviews / shipments 管理"
        phase={{ status: 'planning', label: 'Phase 5' }}
        icon={<Store className="size-5" />}
      />

      <TabBar
        tabs={[
          { key: 'shops', label: '店铺' },
          { key: 'products', label: '商品' },
          { key: 'orders', label: '订单' },
          { key: 'coupons', label: '优惠券' },
        ]}
        active={tab}
        onChange={(key) => setTab(key as 'shops' | 'products' | 'orders' | 'coupons')}
      />

      {tab === 'shops' && (
        <SectionCard title="shops" hint="owner_id / name / status">
          <Placeholder label="店铺列表 + 状态切换" height="h-48" />
        </SectionCard>
      )}
      {tab === 'products' && (
        <SectionCard title="products / product_skus" hint="title / price_cents / credit_price / stock / ai_fields / status">
          <Placeholder
            label="商品列表 + SKU 规格 + 库存（行锁防超卖 §D.4）"
            note="上架走 product_writer；详情走 product_designer"
            height="h-48"
          />
        </SectionCard>
      )}
      {tab === 'orders' && (
        <SectionCard title="orders / order_items" hint="order_no / total_cents / credit_used / pay_channel / pay_status">
          <Placeholder label="订单列表 + 支付状态 + 发货（shipments）" height="h-48" />
        </SectionCard>
      )}
      {tab === 'coupons' && (
        <SectionCard title="coupons" hint="code / type(fixed|percent) / value / min_spend / expire_at">
          <Placeholder label="优惠券发放与核销" height="h-48" />
        </SectionCard>
      )}
    </div>
  );
}

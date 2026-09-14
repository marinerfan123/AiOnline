# 04 — Moling Design System V2

日期: 2026-08-27
技术: React 19 + TypeScript + Tailwind v4 + Radix (shadcn/ui) + lucide-react
视觉方向: 专业 AI 创作工具 / 影视内容生产工作台 — 现代、高密度、简洁。Dark Mode 为主 (light 兼容)。
明确不做: 传统 ERP 风、模板后台风、营销 SaaS 风。

## 1. 设计令牌 (tokens)

### 色彩 (dark 为主, CSS variables + Tailwind @theme)
- surface-0 #0A0B0E (app bg), surface-1 #101216 (panel), surface-2 #16191F (card), surface-3 #1D2129 (hover/elevated)
- border #262B35 (default), border-strong #343B48
- text-primary #F2F4F8, text-secondary #9AA3B2, text-muted #5C6572
- accent (品牌) #6C7CFF 系 (靛蓝紫, AI 创作感), accent-hover #8490FF, accent-dim rgba(108,124,255,.14)
- 语义: success #22C55E, warning #F59E0B, danger #EF4444, info #38BDF8
- 状态色板 (任务): queued=slate, generating=accent, processing=cyan, completed=success, failed=danger, canceled=muted
- 图表/节点类型色: 每类 Studio 节点一个 hue (Prompt=紫, Image=蓝, Video=青, Audio=橙, Subtitle=黄, Character=粉, Output=绿)

### 字体
- 中文: system (PingFang/Microsoft YaHei), 英文/数字: Inter / "IBM Plex Mono" (数据/ID/代码)
- 字阶: 12 (caption/dense table) / 13 (body-dense) / 14 (body) / 16 (h3) / 20 (h2) / 28 (h1)
- 行高: dense 表格 1.2, body 1.5
- 数字表格一律 tabular-nums

### 间距 / 圆角 / 阴影
- 间距基数 4px: 4/8/12/16/24/32; 高密度模式 (admin 表格) 行内 8px, 卡片 gap 12px
- radius: sm 6 (输入), md 10 (卡片), lg 14 (模态), full (badge); 画布节点 8
- elevation: dark 下不用投影, 用 border + surface 层级; light 模式 e1/e2/e3 阴影
- focus ring: 2px accent-dim 内描边 (keyboard a11y)

### 动效 (Motion)
- 时长: micro 120ms (hover/press), standard 200ms (panel/tooltip), large 320ms (modal/drawer)
- 缓动: ease-out 为主; 画布节点入场 scale .96→1 + fade; 列表 stagger 24ms
- 减少动画: prefers-reduced-motion 全降级为 fade

### 图标
- lucide-react 统一 16px (表格/内联) / 18px (导航) / 20px (页面级), stroke 1.75
- 节点图标 = 自定义 24px 双色 (类型色 + 白) SVG, 独立 assets 管理

## 2. 组件清单 (src/components/ui 扩展, Radix 基础)

核心 (重写/新增, 非 Radix 裸用):
- Button (variants: primary/secondary/ghost/danger/destructive; sizes: sm 28/md 32/lg 36; loading 态内置; icon-only)
- Input / Textarea / Select (Radix) / MultiSelect / TagInput
- Table (高密度, sticky header, 列宽拖拽, 虚拟滚动 >100 行, 行选, 排序)
- Card / StatCard (KPI 数字 + 趋势)
- Modal (Drawer 右滑用于详情, Modal 居中用于确认/表单)
- Popover / Tooltip / DropdownMenu / ContextMenu (Radix)
- Toast (sonner 风格, 全局单例, SSE 事件→toast 桥)
- Skeleton (列表/表格/画布节点 三套)
- Empty (插画位 + 行动 CTA, 禁止 mock 数据注入 — 铁律)
- Error (错误块 + 重试按钮; Advanced details 折叠区放技术信息)
- StatusBadge (任务 6 态 / key 池状态 / provider 健康 三套语义)
- Permission (route guard 组件 + 按钮级 disabled+tooltip)
- Breadcrumb / Tabs / Pagination / ProgressBar (生成进度) / CostTag (积分单价徽章)
- NodeCard (画布节点基类: 端口/状态/成本/预览/错误)

保留现有: ui/ 下 Radix 基础 (40+) 直接沿用; premium/、skeleton/ 按新规范重做。

## 3. 布局规范

- User Shell: Sidebar 240px (collapsed 64px, 状态持久化) + Topbar 52px + 内容 max-width 1440px 居中; 表格页全宽
- Admin Shell: Sidebar 240px 分组折叠 + Topbar (全局搜索/监控 dot) + 内容全宽
- Studio Shell: 0 内边距全屏画布; 浮动面板 (Node Library 左抽屉 280px, 检查器 右 320px, 顶栏 48px)
- 响应式断点: <1024 Sidebar 变 overlay, 表格切卡片列表; <768 Studio 降级提示 (画布需桌面, 移动端只读预览)

## 4. 页面模式 (patterns)

- 列表页: FilterBar (top, sticky) + Table/Grid 切换 + Pagination/虚拟滚动 + 行操作 (hover 显示)
- 详情页: 左主内容 + 右 Drawer 检查器; 面包屑
- 配置页 (provider/model/key): 表单分区 + 右侧"实时预览/测试"侧栏 (test-endpoint 结果即时回显)
- 监控页: 时间范围选择 + 图表 (recharts 现有) + 日志流 (SSE, 虚拟列表, 自动滚动锁)
- 画布页: 见 07

## 5. 实施约定

- 所有颜色走 token, 禁止页面内硬编码 hex
- 组件 API 文档写入组件文件 JSDoc; 不做独立 storybook (省成本), 用 /dev-design 内部路由浏览 (生产构建剔除)
- 命名: PascalCase 组件, kebab-case css class, tokens 前缀 --ml-

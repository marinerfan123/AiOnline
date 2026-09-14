# 24 — Community Wave Phases（社区波阶段规划 V3.1）

> 状态：**纯规划文档**。本文未运行任何代码、未执行任何迁移、未做任何运行时验证。
> 所有「可复用」标注均为**文件级证据**（`git ls-files` / 迁移 SQL 快照），非实测通过。
> 拆叶数（拆叶 = flash 构建叶，最小可交付工作项）均为**估算**，非已拆解工时。
>
> 依据：
> - `MOLING_LIBTV_FEATURE_EVIDENCE_LEDGER_V3.1.json`（43 项：C001–C038 + S001–S005）
> - `MOLING_LIBTV_COMMUNITY_GAP_SUPERSET_MATRIX_V3.1.json`（10 new_blockers + 17 superset）
> - `MOLING_LIBTV_COMMUNITY_COMPLETE_DEV_GUIDE_V3.1.md`（§6–9 / §16–18 / §45–52 / §55–59 / §75）
> - `README-vs-blueprint.md`（V3.1 ↔ Blueprint V2.0 门映射）

## 0. 证据等级与排期原则

| 等级 | 含义 | 能否作为「原生 parity」依据 |
|---|---|---|
| **E0** | 官方当前公开页直接确认 | 是（最高置信） |
| **E1** | 公开使用指南 / 多个实测教程一致 | 是 |
| **E2** | 官方/公开 Skill、CLI 代码与文档 | 是 |
| **E3** | 社区/第三方增强信号 | **否**——只作 Moling superset 信号，不得宣称为 LibTV 原生 |

排期规则：
1. **证据等级越高越靠前**；同等级内按依赖关系排序。
2. 无门归属的新工作线（Community / TV Show / Skill Hub / Publish / Team Space / Credit Pool）**不属于 G00–G24 收尾**，单独成波。
3. 与现 G00–G24 重叠的项（如 Storyboard Group → G04/G13、Director Stage → G16）**并入对应门 acceptance 附录**，不在本波重复立项（见 §6 边界）。

C001–C038 中**唯一 E0 P0 社区项是 C001（Community TV Show works）**；C002/C003（Skill Hub 分页/分类）同为 E0 但属 Skill Hub 簇，推迟至 Phase-2。C028（Director Stage，E0/E1）归 G16，不入社区波。

---

## 1. 阶段总表

| 阶段 | 主题 | 证据等级 | 核心账项 | 依赖门 | 新表 | 拆叶数估 | 复用现仓 |
|---|---|---|---|---|---|---|---|
| **Phase-0** | TV Show 浏览/详情/播放（最小） | **E0** | C001 | 媒体服务 LIVE（media 表 + `/media/*` + OSS 代理） | `community_works` | 6–8 | 媒体代理 / media 行 / 资产版本 |
| **Phase-1** | Share vs Publish 域模型 + 发布流 | E1 | C004、C005 | Phase-0（publish 写入 works）；G20 幂等；moderation stub | `project_shares`、`project_share_grants`、`community_publications` | 10–14 | 资产版本 / OSS / 幂等 outbox |
| **Phase-2** | Skill Hub 版本化方法论资产 | E0(E1) | C002、C003、C031（C032 P1 仅建模） | 模型/能力注册 + 成本估算；asset_versions 版本模式 | `skills`、`skill_versions`、`skill_favorites` | 14–18 | 资产版本 / 成本 ledger / capabilityVocab |
| **Phase-3** | Team Space / 权限 / 信用池 / 交接 | E1 | C033–C038 | **G22 契约收敛**（envelope 收敛 + presence + actor + CAS） | `teams`、`team_members`、`team_budgets`、`team_member_quotas`（+ 资产 ownership 扩展） | 16–22 | RBAC(0020) / 预算 ledger(0031/0044) / collab/presence 模块 |
| **Phase-4** | 社区归属 / 审核 / 合规 | E1+E3 | C005(审核)、§56 归属、§59 审核、§60 合规、C006(P1)、S001–S005(部分) | Phase-1（publication 状态机）+ Phase-2（skill 归属）+ Phase-3（team 归属） | `community_attributions`、`moderation_queue`、`moderation_events`、`creator_profiles`、`likes`、`comments` | 12–16 | 资产 rights(0029) / 预算 preflight / media probe |

> **Phase-0 是否含「播放」**：C001 的 E0 证据为 `https://www.liblib.tv/` 首页作品卡可见、可点开。播放本身依赖媒体托管（`media.oss_url` + `/media/*` 静态服务 + `media_jobs.kind IN ('proxy','transcode')`），已 LIVE，故 Phase-0 可安全含「详情 + 播放」，但**不含**点赞/评论/发布/归属（见 Phase-0 不做清单）。

---

## 2. Phase-0 — TV Show 浏览 / 详情 / 播放（E0 P0 最小）

- **目标**：最小可用的社区作品面——按作品卡浏览、进详情、播放成片。E0 级唯一硬核（C001）。
- **证据等级**：E0（官方首页直接确认）。
- **依赖门**：
  - `media` 表 + `/media/*` 静态服务 + `server/oss.cjs`（OSS 代理）已 LIVE（`00-product-capability-matrix.md` §A/C）。
  - `media_jobs`(0036) 的 `proxy/transcode` 任务 + `media_derived_artifacts`(0050) 提供播放衍生件。
  - 无需完整发布流：作品行可由 admin 手工 seed / 导入回填。
- **新表草案**：

```sql
CREATE TABLE community_works (
  work_id            TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  cover_asset_id     TEXT REFERENCES media(id) ON DELETE SET NULL,
  video_asset_id     TEXT REFERENCES media(id) ON DELETE SET NULL,
  duration_ms        INT,
  creator_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  creator_display_name TEXT,
  creator_badge      TEXT,               -- Moling 自有等级，不复制 LibTV 品牌
  tags               JSONB NOT NULL DEFAULT '[]',
  like_count         INT NOT NULL DEFAULT 0,
  comment_count      INT NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'published'
                     CHECK (status IN ('draft','published','taken_down')),
  published_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_community_works_published ON community_works (published_at DESC) WHERE status='published';
CREATE INDEX ix_community_works_creator ON community_works (creator_id);
```

- **拆叶数估**：6–8
  1. 迁移 `0051_community_works`（+ 索引）
  2. 只读 API `GET /api/community/works`（分页/排序）与 `GET /api/community/works/:id`
  3. 前端列表页（Work Card，复用 CommunityWorkCard 字段子集）
  4. 前端详情页 + 视频播放器接入（复用 `/media/*` 播放地址）
  5. admin seed/导入脚本（回填已有 media 为 works）
  6. e2e（`community-work` spec：列表→详情→播放）
- **不做清单（防范围膨胀）**：
  - ❌ 点赞/评论/通知（C006，P1）
  - ❌ 发布流（C005）——本阶段仅展示，不产生
  - ❌ Skill 归属（§56）——Phase-4
  - ❌ 创作者主页/等级体系（§58）——Phase-4
  - ❌ 搜索/筛选高级面（S001–S005 部分）——Phase-4 或独立 superset 波
  - ❌ 复制 LibTV 品牌标签（「先锋/专业/荣誉」）——Moling 用自有 badge

---

## 3. Phase-1 — Share vs Publish 域模型 + 发布流（E1）

- **目标**：把 Share（实时画布链接，`ProjectSharePolicy`）与 Publish（画布+成片+封面/标题/说明→审核→Community）锁死为**两个域概念**，禁止合并为一个按钮/权限模型（§6）。
- **证据等级**：E1（C004 Share canvas live link；C005 Publish canvas+video）。
- **依赖门**：
  - Phase-0（publish 写入 `community_works`）。
  - G20 幂等（`idempotency_key` 已有）；outbox（0025 `event_outbox`）做发布事件扇出。
  - moderation stub：发布默认走「mocked/real moderation」门（COMMUNITY-P01 允许 mocked）。
  - G01 copy 语义（C011/C012：Copy 不保留外部连线 / Duplicate 保留）——本波仅限「发布时画布快照」，不重做 copy 语义（归 G01）。
- **新表草案**：

```sql
-- Share：实时画布查看链接（与 publish 无关）
CREATE TABLE project_shares (
  share_id      TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  token         TEXT NOT NULL UNIQUE,
  visibility    TEXT NOT NULL DEFAULT 'public_link'
                CHECK (visibility IN ('public_link','team','specified_members')),
  role          TEXT NOT NULL DEFAULT 'viewer'
                CHECK (role IN ('viewer','commenter','editor')),
  allow_copy    BOOLEAN NOT NULL DEFAULT false,
  allow_download BOOLEAN NOT NULL DEFAULT false,
  allow_publish BOOLEAN NOT NULL DEFAULT false,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE project_share_grants (       -- visibility='specified_members'
  share_id TEXT NOT NULL REFERENCES project_shares(share_id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (share_id, user_id)
);

-- Publish：发布到社区的独立状态机
CREATE TABLE community_publications (
  publication_id   TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  work_id          TEXT REFERENCES community_works(work_id) ON DELETE SET NULL,
  snapshot_asset_id TEXT,                 -- 发布时画布快照（复用 asset_versions 模式）
  cover_asset_id   TEXT,
  video_asset_id   TEXT,
  title            TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','submitted','moderating','published','rejected','taken_down')),
  rejected_reason  TEXT,
  moderation_meta  JSONB NOT NULL DEFAULT '{}',
  published_at     TIMESTAMPTZ,
  published_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- **拆叶数估**：10–14
  1. 迁移 `0052_project_shares` + `0053_community_publications`（+ share_grants）
  2. Share 服务：创建/撤销/鉴权（`ProjectSharePolicy` 落库）
  3. Share 查看端点（实时画布只读/只读+评论）
  4. Publish 服务：canvas snapshot → publication draft
  5. 审核状态机（draft→submitted→moderating→published/rejected；mock reviewer）
  6. 发布事件 outbox 扇出（work 落 `community_works`）
  7. 前端 Share 对话框（权限三档 + copy/download/publish 开关）
  8. 前端 Publish 表单（封面/标题/说明/成片）
  9. e2e：COMMUNITY-P01（发布→可见）；share 权限矩阵用例
- **不做清单**：
  - ❌ 点赞/评论/消息通知（C006，P1）——Phase-4
  - ❌ 团队 visibility 范围（`team` 档）真正鉴权——依赖 Phase-3 teams 表，本波仅留 enum 占位
  - ❌ 归属图（used skills/workflows）——Phase-4
  - ❌ 真审核队列/人工审核台——Phase-4；本波用 mock/stub
  - ❌ Copy/Fork 项目语义（G01/G15）——并入门，不重做

---

## 4. Phase-2 — Skill Hub 版本化方法论资产（E0 分页 / E1 创建）

- **目标**：Skill 作为**版本化方法论资产**而非 prompt 字符串（§10）；Hub 三 tab（Explore/Favorites/Mine）+ 分类 + 搜索 + Creator + usage count + preview + 输入/输出/成本 + Manual/Auto 支持（§9）。
- **证据等级**：C002/C003 = E0（分页/分类）；C031 = E1（自定义 Skill 创建）；C032 = P1（创作者生态，仅建模兼容）。
- **依赖门**：
  - 模型/能力注册（`modelRegistry.cjs`、`capabilityVocab.cjs`）——Skill 声明 `requiredCapabilities`。
  - 成本估算（`generation-entry/quoteService.cjs` / `model_cost_rates`）——Skill 显示 `estimated cost range`。
  - 版本模式复用 `asset_versions`(0032)（`version_id`/`kind`/`status`/`origin` 同构）。
  - Manual/Auto 语义对齐 §13（Manual / GUIDED / AUTO_WITH_BUDGET / FULL_AUTO）——Agent 面（G19），本波只建模字段。
- **新表草案**：

```sql
CREATE TABLE skills (
  skill_id        TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  description     TEXT,
  category        TEXT NOT NULL,          -- 推荐/短漫剧/电影/商业广告/创意/MV
  creator_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  scope           TEXT NOT NULL DEFAULT 'private'
                  CHECK (scope IN ('private','team','public')),
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','published','taken_down')),
  preview_asset_id TEXT,
  required_inputs JSONB NOT NULL DEFAULT '[]',
  expected_output JSONB NOT NULL DEFAULT '{}',
  est_cost        JSONB NOT NULL DEFAULT '{}',
  mode            TEXT NOT NULL DEFAULT 'manual'
                  CHECK (mode IN ('manual','guided','auto_with_budget','full_auto')),
  usage_count     INT NOT NULL DEFAULT 0,
  favorite_count  INT NOT NULL DEFAULT 0,
  fork_of         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 版本：方法论资产版本（复用 asset_versions 同构）
CREATE TABLE skill_versions (
  version_id   TEXT PRIMARY KEY,
  skill_id     TEXT NOT NULL REFERENCES skills(skill_id) ON DELETE CASCADE,
  version_no   INT NOT NULL,
  definition   JSONB NOT NULL,            -- graphTemplate + exposedInputs/Outputs + variables
  changelog    TEXT,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (skill_id, version_no)
);

CREATE TABLE skill_favorites (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(skill_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, skill_id)
);
```

> **未来兼容（Phase-4 之前只建模不建表即可，或建空表占位）**（§57）：
> `skill_usage_events` / `skill_installs` / `skill_ratings` / `skill_forks` / `skill_revenue_events`——避免日后商业化重构。

- **拆叶数估**：14–18
  1. 迁移 `0054_skills` + `0055_skill_versions` + `0056_skill_favorites`
  2. Skill 域服务（版本化 upsert、版本列表、语义校验）
  3. Skill 校验/lint（最少：requiredCapabilities 是否满足 capabilityVocab）
  4. Skill 创建入口（§11）+ 编辑器（版本 + changelog）
  5. Hub 三 tab + 分类 + 搜索 API
  6. 收藏/取消收藏
  7. 预览（preview_asset_id 渲染）
  8. 输入/输出/成本展示（对接 quoteService）
  9. Manual/Auto 声明展示
  10. `Use this Skill` → New Project（§8 转化链起点）
  11. e2e：COMMUNITY-P03（收藏→Favorites）、COMMUNITY-P04（私有 Skill→发布/fork 链）
- **不做清单**：
  - ❌ 现金市场/创作者分成（C032，P1）——仅数据模型兼容
  - ❌ Skill lint/test/diff/version 完整工具链（Moling superset 列表项）——只做最少 lint
  - ❌ 社区 Skill 归属关系落地到 works（§56）——Phase-4
  - ❌ 创作者激励/评级/分成的 UI——Phase-4

---

## 5. Phase-3 — Team Space / 权限 / 信用池 / 交接（E1，P0_TEAM）

- **目标**：团队空间（创建/邀请/迁移项目）、团队权限（project access/edit/copy/publish + viewer/commenter/download/export/run/manage-cost）、共享信用池（team budget/member quota/monthly cap/实际消耗）、成员退出资产交接（显式 `createdBy/ownedBy/organizationId`）。
- **证据等级**：E1（C033–C038，team 实测报告）。
- **依赖门（硬门）**：**G22 契约收敛**
  - `envelopes.cjs` 命令信封与落库协议（`clientMutationId+baseRevision`）两套并存 → 需收敛（`18-collaboration-g22-audit.md`）。
  - presence 协议（在线态/心跳/TTL/成员列表/光标/编辑指示）。
  - actor 协作参与者模型（非仅鉴权主体）。
  - CAS + soft presence lock（§45/§46）。
  - 注意：`18-collaboration-g22-audit.md`（2026-09-03）把 presence 标为「零」，但当前树内已见 `server/modules/collaboration/presenceApi.cjs / presenceBus.cjs / presencePgStore.cjs`——**Phase-3 启动前须重新核对该审计**，presence 现状以重测为准。
- **新表草案**：

```sql
CREATE TABLE teams (
  team_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  invite_token TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE team_members (
  team_id    TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_role TEXT NOT NULL DEFAULT 'Viewer'
             CHECK (access_role IN ('Owner','Admin','Billing Admin','Editor','Reviewer','Viewer')), -- 复用 0020 六角色
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invited_by TEXT,
  PRIMARY KEY (team_id, user_id)
);
CREATE TABLE team_budgets (              -- 复用 project_budgets(0031) 模式，作用域=team
  team_id    TEXT PRIMARY KEY REFERENCES teams(team_id) ON DELETE CASCADE,
  budget     NUMERIC(18,4) NOT NULL,
  warning_threshold NUMERIC(18,4) NOT NULL DEFAULT 0.8,
  approval_threshold NUMERIC(18,4) NOT NULL DEFAULT 1.0,
  monthly_cap NUMERIC(18,4),
  spent      NUMERIC(18,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE team_member_quotas (
  team_id    TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  monthly_quota NUMERIC(18,4),
  spent      NUMERIC(18,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, user_id)
);
-- 资产交接：显式 ownership 扩展（§50）
-- 给 projects / assets 增加 organization/team 归属列（owned_by / organization_id），
-- 成员退出只撤访问权，不改变资产存在（TEAM-P05）。
```

- **拆叶数估**：16–22
  1. G22 契约收敛（envelope↔落库协议统一）——**前置，不计入本波叶或单列为门**
  2. presence 协议落地（realtime，SSE/WS 扇出）
  3. remote cursor / selection / editing marker（TEAM-P01/P02）
  4. 迁移 `teams` / `team_members` / `team_budgets` / `team_member_quotas`（+ 资产 ownership 列）
  5. Team 服务（create/invite-via-link/move personal project→team，§47）
  6. Team 权限服务（复用 access_role 六角色 + project 级 viewer/commenter/download/export/run/manage-cost，§48）
  7. 共享信用池：team budget + member quota + monthly cap + 实际消耗（§49；预留 reservation/forecast/anomaly）
  8. 预算超限拦截：Agent run 前 cap 检查（TEAM-P06，复用 budget preflight）
  9. 成员退出交接：资产归属/访问撤销（TEAM-P05，§50）
  10. Team subject/asset library（§51，复用 Production Bible 结构化）
  11. e2e：TEAM-P01–P06
- **不做清单**：
  - ❌ 字段级 CRDT/OT 三路合并——当前基线为整画布 CAS-409 + reload；字段级 merge 不在本波（除非 G22 门明确要求）
  - ❌ 跨团队 federation / 组织嵌套
  - ❌ 团队 Skill Hub（team scope 的 Skill 发布流）——skill scope enum 已留 `team`，但 UI 归 Phase-2/4
  - ❌ reservation/forecast/anomaly 全套成本智能——只建模字段，不做算法

---

## 6. Phase-4 — 社区归属 / 审核 / 合规（E1 + E3 superset）

- **目标**：归属图（used skills/workflows/styles/presets，creator 控制是否公开）、审核生命周期（draft→submit→moderation→published + rejected reason / revision resubmit / takedown / unpublish）、合规 preflight（file validation/media probe/capability/policy/budget preflight）、创作者主页。
- **证据等级**：E1（§56/§58/§59/§60）+ E3（S001–S005 部分，作为 superset，不标原生）。
- **依赖门**：Phase-1（publication 状态机）、Phase-2（skill 归属实体）、Phase-3（team 归属，若 team 发布）。
- **新表草案**：

```sql
CREATE TABLE community_attributions (
  work_id     TEXT NOT NULL REFERENCES community_works(work_id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('skill','workflow','style','preset')),
  entity_id   TEXT NOT NULL,
  is_public   BOOLEAN NOT NULL DEFAULT true,   -- creator 控制是否公开
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (work_id, entity_type, entity_id)
);
CREATE TABLE moderation_queue (
  item_id    TEXT PRIMARY KEY,
  item_type  TEXT NOT NULL CHECK (item_type IN ('work','skill','style','workflow')),
  status     TEXT NOT NULL DEFAULT 'submitted'
             CHECK (status IN ('submitted','moderating','published','rejected')),
  submitted_by TEXT REFERENCES users(id),
  reviewed_by   TEXT REFERENCES users(id),
  decision    TEXT,
  rejected_reason TEXT,
  revision    INT NOT NULL DEFAULT 0,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE moderation_events (           -- 审核审计轨迹
  event_id   TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL,
  item_type  TEXT NOT NULL,
  action     TEXT NOT NULL,                -- submit/reject/approve/takedown/unpublish
  actor_id   TEXT,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE creator_profiles (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  avatar_asset_id TEXT,
  display_name TEXT NOT NULL,
  badge        TEXT,                       -- Creator/Professional/Studio/Verified Expert（Moling 自有）
  bio          TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE likes (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id  TEXT NOT NULL REFERENCES community_works(work_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, work_id)
);
CREATE TABLE comments (
  comment_id TEXT PRIMARY KEY,
  work_id    TEXT NOT NULL REFERENCES community_works(work_id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- **拆叶数估**：12–16
  1. 迁移 `community_attributions` / `moderation_queue` / `moderation_events` / `creator_profiles` / `likes` / `comments`
  2. 归属写入（发布时自动关联 used skills/workflows，§56）+ 公开开关
  3. 审核服务（submit/reject/approve/takedown/unpublish + revision resubmit）
  4. 审核台 UI（人工审核 + 事件审计）
  5. 合规 preflight（file/media probe/capability/policy/budget，§60，复用 media probe + budget preflight）
  6. 点赞/评论 + 消息通知（C006，P1）
  7. 创作者主页（§58，Moling 自有 badge）
  8. `Made with Skill: …` 展示（§56）
  9. e2e：COMMUNITY-P02（归属→Use Skill→新项目）、审核全生命周期、preflight 拦截用例
- **不做清单**：
  - ❌ 现金市场/分成结算（§57，P1）——仅数据模型
  - ❌ follower/social graph——可选，不排期
  - ❌ AI QA（Moling superset 列表项）——独立波
  - ❌ 完整法律合规审查引擎——preflight 只做技术性前置拦截（尺寸/格式/capability/budget/policy），不做法律裁决
  - ❌ S001–S005 中与社区无关的（Node search / Chain highlight / Focus mode 属画布导航）——归画布 superset 波，不入社区波

---

## 7. 复用现仓标注（文件级证据，非实测通过）

| 现仓资产 | 位置（git 树） | 复用到 | 备注 |
|---|---|---|---|
| **媒体代理 / media 行** | `server/modules/media/*`（`mediaWorker`/`jobQueue`/`mediaDerivedStore`/`uploadApi`）；`server/oss.cjs`（OSS 签名上传/ingest/proxy）；`media` 表 + `/media/*` 静态服务 | Phase-0 播放/封面、Phase-1 发布封面/成片、Phase-2 预览、Phase-4 preflight media probe | `media_jobs.kind`(0036) 含 `proxy/transcode/thumbnail/waveform/frame_extract/render`；`media_derived_artifacts`(0050) 供播放衍生件 |
| **预算 ledger** | `project_budgets`(0031) + `project_budget_spends`(0044)；`server/modules/project-foundation/budget.cjs` + `budgetSpentStore.cjs`；`generation-v2/ledger.cjs` + `commercial-ledger.cjs` | Phase-3 team budget（同构 team 作用域）、Phase-4 budget preflight | team_budgets 直接镜像 project_budgets 结构 |
| **资产版本** | `asset_versions`(0032)；`assetVersion.cjs` + `assetLineage.cjs`（`server/modules/project-foundation/`） | Phase-2 skill_versions、Phase-1 发布快照版本化、Phase-4 归属/溯源 | `version_id/kind/status/origin` 模式直接复用 |
| **资产 rights / provenance** | `asset_rights`(0029)；`assetRights.cjs` | Phase-4 归属与溯源、license/consent/commercial_usage | 发布作品自动关联 used skills 可挂 `asset_rights` 溯源链 |
| **RBAC** | `workspace_members.access_role`(0020 六角色)；`rbacRoles.cjs` + `rbacEnforcement.cjs` | Phase-3 team_members 角色、team 权限 | 六角色层级（Owner/Admin/Billing Admin/Editor/Reviewer/Viewer）直接复用 |
| **协作 / G22** | `server/modules/studio-contracts/collabContract.cjs` + `envelopes.cjs`；`server/modules/collaboration/presenceApi.cjs` + `presenceBus.cjs` + `presencePgStore.cjs`；`studioCanvasPersistence.cjs`（CAS+409） | Phase-3（硬门依赖） | **需重测**：G22 审计标 presence「零」但文件已在树内，Phase-3 启动前复核 |
| **幂等 / outbox** | `event_outbox`(0025)；`generation-v2` idempotency 模式 | Phase-1 发布事件扇出 | 发布落 works 用幂等 + outbox |
| **成本估算** | `generation-entry/quoteService.cjs` + `model_cost_rates` | Phase-2 Skill 成本展示 | 显示 `estimated cost range` |

---

## 8. 边界与开放项

- **并入现门、不在社区波立项**（依 `README-vs-blueprint.md` §10 blockers）：Storyboard Group(C013/C014)→G04/G13、Canvas/Storyboard/Agent 三视图(C029)→G05/G13/G16、Copy/Paste vs Duplicate(C011/C012)→G01、History 批量(C009)→G02、Director Stage(C028)→G16、Manual/Auto(C030)→G19/G15、视频合成底栏(C024)→G18、音频分离/字幕擦除(C025–C027)→G18/G09。
- **Moling superset 已在仓**（README §Moling superset）：Continuity Engine(G14)、Production Bible(G14)、Immutable assets(G06/versions)、CAS semantic rebase(G02)、Generation intent CAS、Media normalize/proxy(G06)、Backup restore(G21)、Fork lineage(G15)、Budget-aware(G20)。**未建**（独立 superset 波，非社区波）：Node search/Chain highlight/Focus mode/LOD/Skill 工具链/AI QA/Community attribution graph（后者并入 Phase-4）。
- **E3 纪律**：S001–S005 及所有「社区增强信号」在文档与验收中**必须标注 E3**，不得宣称为 LibTV 原生 parity。
- **品牌纪律**：不复制 LibTV 创作者等级标签与分类名；Moling 建立等价自有体系（§7/§58）。

---

## 9. 阶段要点回传（供父任务汇总）

1. 排期按**证据等级**：Phase-0=E0（C001 唯一 E0 P0 社区项）→ Phase-1/2/3=E1 → Phase-4=E1+E3。
2. 每阶段 5 要素已列齐：目标 / 依赖门 / 新表草案 / 拆叶数估 / 不做清单。
3. 复用面：媒体代理+media 行、预算 ledger(0031/0044)、资产版本(0032)、RBAC(0020)、协作 G22 模块（presence 需重测）、幂等 outbox、成本估算。
4. 硬依赖：Phase-3 卡 **G22 契约收敛**（envelope↔落库协议 + presence + actor + CAS）。
5. 边界：C011–C030 中大量项并入 G00–G24 门，不重复立项；E3 项单独标注不混称原生。

-- 0042_character_aliases_constraint.sql
-- G14 余项③: DB 底线约束 for project_characters.aliases.
-- aliases 由 0038 加列: JSONB NOT NULL DEFAULT '[]'::jsonb (表本身建于 0027)。
-- 目前只有 JS 层校验"字符串数组"; 本迁移把 DB 层兜底补上, 保证该列必为 JSON
-- 数组(容器类型), 元素级校验仍由 JS 层做主。Additive + forward-only。

-- ① 加约束前先清理历史脏数据: 凡绕过 JS 校验落库的非法值一律重置为列默认值。
-- 拆成两条 UPDATE, 每条谓词单独看都不会报错:
--   ①a jsonb_typeof(aliases) IS DISTINCT FROM 'array'
--       -- 覆盖非数组 JSON(object/string/number/boolean/json null), 顺带
--         防御 NULL(列本身 NOT NULL, 用 IS DISTINCT FROM 保持稳健)。
--   ①b ①a 之后剩下的行全部是数组, 此时 jsonb_array_elements 在任何行上都
--       安全; 该条把"含至少一个非字符串元素"(数字/布尔/对象/数组/null)的
--       数组重置为 '[]'。
-- 刻意没用单条 OR(非数组 OR 含非字符串)写法: PostgreSQL 不保证 WHERE
-- 各条件求值顺序, jsonb_array_elements 绝不能在非数组值上执行, 两条 UPDATE
-- 可确定性规避该风险。
UPDATE project_characters
SET aliases = '[]'::jsonb
WHERE jsonb_typeof(aliases) IS DISTINCT FROM 'array';

UPDATE project_characters
SET aliases = '[]'::jsonb
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements(aliases) AS elem
  WHERE jsonb_typeof(elem) <> 'string'
);

-- ② DB 底线: aliases 必须是 JSON 数组(容器级)。
-- JS 层仍为主校验方(字符串数组 / 非空 / 去重等业务规则在 JS); DB 只保证
-- 容器类型, 使下游(0038 @-alias resolver 的 jsonb_array_elements_text)
-- 永远不会因类型问题抛错。
-- NOTE (可选 future): 若日后要在 DB 层做元素级类型约束, 可收紧为
--   CHECK (NOT EXISTS (
--     SELECT 1 FROM jsonb_array_elements(aliases) e
--     WHERE jsonb_typeof(e) <> 'string'
--   ))
-- 当前有意不做: 与 JS 校验重复、给写入路径加成本, 且元素语义(是否允许
-- 空串 / 重复别名)属业务规则, 应留在 JS 单一处维护。
ALTER TABLE project_characters
  ADD CONSTRAINT chk_character_aliases
  CHECK (jsonb_typeof(aliases) = 'array');

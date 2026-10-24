# Shortlink Design System — 冻结契约 v1.0

> 本文件是 ONE-88 Stage 2/3/4 的**唯一 token 与视觉方向依据**。命名即接口，冻结后任何变更须经 Mike 裁决。
> 适用代码基线：React 19 + Vite 8 + Tailwind CSS v4（CSS-first，`@theme` 声明）+ i18n（en / zh-CN）+ ThemeContext 明暗三态（light / dark / system）。
> 颜色以 HSL 三通道（`H S% L%`）存储于 CSS 变量，明暗两套取值分别挂 `:root` 与 `.dark`，与现有 `globals.css` 结构兼容。

## 0. 视觉方向（一句话）

**「安静的精密仪器」**：以编辑级排版（editorial typography）与克制的大留白为骨架，单一高饱和电蓝作为唯一强调色，其余界面保持近中性灰阶；动效只做「短促、有物理感、可预期」的微反馈，让工具类产品呈现获奖级作品的秩序感与质感。

## 1. 基准调研（可对照获奖条目）

| 条目 | 奖项/站点 | 可借鉴点 |
| --- | --- | --- |
| **Linear**（linear.app） | Awwwards Site of the Day ×多次 | 近中性深灰暗色主题（非纯黑）、单一强调色贯穿、120–200ms 的 `ease-out` 微交互、命令面板级键盘可达性、超大行高比的紧凑数据密度 |
| **Stripe Dashboard / stripe.com** | Webby 最佳视觉设计（多次提名/获奖） | 编辑级字号阶梯（display → caption 的明确阶层）、大留白 + 细分隔线代替卡片堆叠、明暗主题下阴影策略分离（暗色用描边+辉光而非投影） |
| **Vercel Dashboard**（vercel.com） | FWA / Awwwards 收录 | 几何无衬线字体（Geist）带来的「工程感」、三角形/极简图标体系、表格行的 hover 微位移、纯黑 `#000` 与纯白的极端对比主题 |

## 2. Token 总览（10 组）

| # | 组 | CSS 变量前缀 | 明暗双套 |
| --- | --- | --- | --- |
| 1 | 字体族 | `--font-sans` / `--font-mono` | 否（单套） |
| 2 | 字号阶梯 | `--text-*` | 否 |
| 3 | 行高 | `--leading-*` | 否 |
| 4 | 字重 | `--font-weight-*` | 否 |
| 5 | 字距 | `--tracking-*` | 否 |
| 6 | 间距 | `--spacing-*` | 否 |
| 7 | 阴影 | `--shadow-*` | **是** |
| 8 | 缓动 | `--ease-*` | 否 |
| 9 | 动效时长 | `--duration-*` | 否 |
| 10 | 颜色与圆角 | `--<semantic>` / `--radius-*` | 颜色**是**，圆角否 |

### 2.1 字体族

| Token | 值 | 用途 |
| --- | --- | --- |
| `--font-sans` | `"Inter", -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif` | 全局 UI。Inter 需随应用自托管或通过 fontsource 引入（latin + latin-ext，zh-CN 走系统字体回退，不加载中文 WebFont） |
| `--font-mono` | `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` | 短链 slug、API key、统计数字、代码片段 |

> 现状差距：当前全局为 Tailwind 默认系统栈，无品牌字体。Stage 2 引入 Inter（`font-display: swap`）。

### 2.2 字号阶梯（rem 基准 16px）

| Token | 值 | px | 用途 |
| --- | --- | --- | --- |
| `--text-display` | `2.25rem` | 36 | Setup 页主标题、空状态大标题 |
| `--text-h1` | `1.875rem` | 30 | 页面级标题 |
| `--text-h2` | `1.5rem` | 24 | CardTitle、分区标题 |
| `--text-h3` | `1.25rem` | 20 | 卡片内小标题、Dialog 标题 |
| `--text-body-lg` | `1rem` | 16 | 表单正文、重要段落 |
| `--text-body` | `0.875rem` | 14 | 默认正文、按钮、表格 |
| `--text-caption` | `0.75rem` | 12 | Badge、辅助说明、时间戳 |
| `--text-micro` | `0.6875rem` | 11 | 表格次要列、状态脚注 |

### 2.3 行高

| Token | 值 | 配搭 |
| --- | --- | --- |
| `--leading-display` | `1.1` | display / h1 |
| `--leading-heading` | `1.25` | h2 / h3 |
| `--leading-body` | `1.5` | body-lg / body |
| `--leading-caption` | `1.4` | caption / micro |

### 2.4 字重

| Token | 值 | 用途 |
| --- | --- | --- |
| `--font-weight-regular` | `400` | 正文 |
| `--font-weight-medium` | `500` | 按钮、导航项、Label |
| `--font-weight-semibold` | `600` | 卡片标题、强调正文、Badge |
| `--font-weight-bold` | `700` | 页面标题、品牌字标 |

> 禁止引入 300 / 800+ 的极端字重，保持字重阶层≤4。

### 2.5 字距（letter-spacing）

| Token | 值 | 用途 |
| --- | --- | --- |
| `--tracking-tight` | `-0.02em` | display / h1 / h2（大字号收紧） |
| `--tracking-normal` | `0` | 正文 |
| `--tracking-wide` | `0.01em` | 按钮、导航 |
| `--tracking-caps` | `0.08em` | 全大写微型标签（表头、分区眉题） |

### 2.6 间距（4px 基网，Tailwind 数字工具类即乘 4）

| Token | 值 | 语义 |
| --- | --- | --- |
| `--spacing-1` | `0.25rem` (4) | 图标与文字间隙下限 |
| `--spacing-2` | `0.5rem` (8) | 紧凑控件内距、表单 label→input |
| `--spacing-3` | `0.75rem` (12) | 按钮水平内距、导航项内距 |
| `--spacing-4` | `1rem` (16) | 控件组间距、卡片内小组距 |
| `--spacing-6` | `1.5rem` (24) | 卡片内边距（p-6）、区块间距 |
| `--spacing-8` | `2rem` (32) | 页面区块大间距 |
| `--spacing-12` | `3rem` (48) | 页面顶部留白、空状态上下留白 |
| `--spacing-16` | `4rem` (64) | Auth 页垂直节奏、大屏页面留白 |

> 规则：所有布局间距必须落在 4px 基网上，禁用 `p-[13px]` 类任意值；卡片内边距统一 `--spacing-6`，大屏（≥lg）可升至 `--spacing-8`。

### 2.7 阴影（明暗双套）

暗色主题下投影不可见，改用「描边 + 顶部微光」策略；token 值整体替换。

| Token | Light | Dark | 用途 |
| --- | --- | --- | --- |
| `--shadow-xs` | `0 1px 2px 0 rgb(0 0 0 / 0.04)` | `0 1px 2px 0 rgb(0 0 0 / 0.4)` | Input、Switch 滑块 |
| `--shadow-sm` | `0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.06)` | `inset 0 1px 0 0 rgb(255 255 255 / 0.04)` | Card 默认 |
| `--shadow-md` | `0 4px 8px -2px rgb(0 0 0 / 0.08), 0 2px 4px -2px rgb(0 0 0 / 0.06)` | `0 0 0 1px rgb(255 255 255 / 0.06), inset 0 1px 0 0 rgb(255 255 255 / 0.06)` | 下拉、Popover |
| `--shadow-lg` | `0 12px 32px -8px rgb(0 0 0 / 0.14), 0 4px 8px -4px rgb(0 0 0 / 0.08)` | `0 0 0 1px rgb(255 255 255 / 0.08), 0 16px 48px -8px rgb(0 0 0 / 0.6)` | Dialog |
| `--shadow-focus` | `0 0 0 3px hsl(var(--ring) / 0.35)` | `0 0 0 3px hsl(var(--ring) / 0.45)` | focus-visible 光环（替代 ring-offset 方案） |

### 2.8 缓动

| Token | 值 | 用途 |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | 默认入场/hover（快速起步、柔和收尾） |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | 状态翻转（Switch、Tab 指示条） |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 微回弹：Toast 入场、复制成功打勾 |
| `--ease-linear` | `linear` | 仅 loading 旋转 |

> 禁用 Tailwind 默认 `ease-in`（物体不该从静止缓慢起步）。

### 2.9 动效时长

| Token | 值 | 用途 |
| --- | --- | --- |
| `--duration-instant` | `75ms` | 按下态、焦点环 |
| `--duration-fast` | `150ms` | hover 变色、按钮反馈（默认 transition） |
| `--duration-normal` | `200ms` | 下拉/Tooltip 入场、Tab 切换 |
| `--duration-slow` | `300ms` | Dialog/抽屉入场、页面级淡入 |
| `--duration-spin` | `700ms` | loading 旋转一周 |

> 任何过渡 ≤300ms；交互反馈（click → 视觉响应）必须 ≤150ms。全部组件统一使用 `transition-[property] duration-[var(--duration-fast)] ease-[var(--ease-out)]` 模式，禁止散落裸 `transition-colors` 而无时长语义——Stage 2 收敛为组件级预设类。

### 2.10 颜色与圆角（明暗双套，HSL 通道）

语义层在现有变量上**补全**（保留现有命名不动，新增以下项）。品牌强调色由「近黑」改为**电蓝**，light/dark 同色相不同明度。

| Token | Light | Dark | 说明 |
| --- | --- | --- | --- |
| `--background` | `0 0% 100%` | `222 47% 6%`（微调：非纯黑、带蓝相） | 页面底色 |
| `--foreground` | `222 47% 11%` | `210 40% 96%` | 主文字 |
| `--card` | `0 0% 100%` | `222 40% 9%`（与 background 拉开一档） | 卡片底 |
| `--card-foreground` | 同 foreground | 同 foreground | |
| `--popover` | 同 card | 同 card | |
| `--popover-foreground` | 同 foreground | 同 foreground | |
| `--primary` | `217 91% 50%`（电蓝） | `217 91% 60%` | 唯一强调色：主按钮、链接、激活态 |
| `--primary-foreground` | `0 0% 100%` | `222 47% 6%` | |
| `--secondary` | `210 40% 96%` | `217 33% 15%` | |
| `--secondary-foreground` | 同 foreground | 同 foreground | |
| `--muted` | `210 40% 96%` | `217 33% 15%` | |
| `--muted-foreground` | `215 16% 42%`（加深，对比度 ≥4.5） | `215 20% 68%` | |
| `--accent` | `217 91% 96%`（蓝的 6% 浅底） | `217 60% 18%` | hover/选中底色，与 primary 同族 |
| `--accent-foreground` | `217 91% 40%` | `210 40% 96%` | |
| `--destructive` | `0 84% 55%` | `0 72% 55%`（提亮，暗底可读） | |
| `--destructive-foreground` | `0 0% 100%` | `0 0% 100%` | |
| `--success` | `152 69% 35%` | `152 60% 48%` | **新增**：成功 Badge / Toast 图标（替代现写死 `bg-green-100 text-green-800`） |
| `--success-foreground` | `0 0% 100%` | `222 47% 6%` | **新增** |
| `--warning` | `38 92% 45%` | `38 92% 55%` | **新增**：过期/待处理状态 |
| `--warning-foreground` | `0 0% 100%` | `222 47% 6%` | **新增** |
| `--border` | `214 32% 88%`（加深一档，1px 描边可辨） | `217 33% 18%` | |
| `--input` | 同 border | 同 border | |
| `--ring` | `217 91% 50%` | `217 91% 60%` | 焦点环 = primary |
| `--chart-1..5` | `217 91% 50%` / `173 58% 39%` / `43 74% 55%` / `280 60% 55%` / `350 75% 55%` | `217 91% 62%` / `160 60% 45%` / `43 80% 60%` / `280 65% 65%` / `350 75% 62%` | 图表色族，chart-1 恒等于 primary 族 |

**圆角**

| Token | 值 | 用途 |
| --- | --- | --- |
| `--radius` | `0.5rem` | 基准（保持现状，向后兼容 md/lg 计算） |
| `--radius-sm` | `calc(var(--radius) - 4px)` | Badge 内嵌、小图标块 |
| `--radius-md` | `calc(var(--radius) - 2px)` | Button、Input、Select |
| `--radius-lg` | `var(--radius)` | Card、Dialog |
| `--radius-full` | `9999px` | Badge、Switch、头像 |

## 3. 落地映射（Stage 2 实施约定）

1. `globals.css` 顶部 `@theme`（Tailwind v4 CSS-first）声明 2.1–2.9 的非颜色 token；颜色继续在 `:root` / `.dark` 下维护（兼容 ThemeContext 的 class 切换），并新增 `--success*` / `--warning*`。
2. 废除 `tailwind.config.js` 的 `theme.extend` 双份维护，迁移为 CSS-first 单一来源；`components.json` 同步更新。
3. 每页标题阶层：h1 页面标题 + `--tracking-tight`，表头使用 caption + `--tracking-caps` 全大写。
4. 数字（点击量、统计卡数值）一律 `font-mono` + `--font-weight-semibold`。

## 4. 冻结条款

- 以上 token 名与取值自本文件合入起冻结；新增 token 可在附录追加，**改名/改值**须报 Mike 裁决。
- 任何页面/组件不得使用未在本文件列出的字号、阴影、缓动、时长字面值；颜色必须经语义变量引用，禁止裸写 HSL/hex。

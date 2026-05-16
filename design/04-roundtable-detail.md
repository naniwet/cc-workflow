# 04 · roundtable 详情(手机) — 设计规格

> 配套:`04-roundtable-detail.html`
>
> 跟 02/03 共用同一套设计语言(齿轮菜单 / persona 折叠 / 状态色),但 stream 结构不同——roundtable 是多 persona 并行/串行,不是单一时间线。

---

## 1. 这张稿要解决什么

01 概览 Roundtable tab 点某个辩论进来。需要:

- 看清楚 4+1 个 persona 分别说了什么 / 还在等什么
- 进行中能看到实时进度(谁说完、谁在写、谁还排队)
- done 时一眼看到 synthesis(用户最关心的结论)
- 没有"再发一句"的概念 —— 辩论是一次性的

---

## 2. 与其它稿的衔接

- **01 概览 Roundtable tab** 的辩论行 → 点进来到 04 详情(对应 `#roundtables/<id>` 路由,现状已有 `renderRoundtableDetailView`)
- **02 / 03 的齿轮菜单** 复用同一组样式(`.gear-popout` / `.gear-item` / `.gear-section`),只是内容只有 3 项

---

## 3. 关键交互决策

### 3.1 没有 input bar(跟 03 一致)

**决策:** 辩论一次性,问完就跑完了。要新讨论开新问题。详情页底部不放 sticky 输入框。

**收益:** 视觉简洁;不会让用户误以为可以"追问"。
**代价:** 无,因为这就是辩论的本质属性。

### 3.2 Question 是一等公民

顶部第一块就是 question card,字号 15px(比所有正文都大),**没有折叠**——它就是这张页面的本体。

**为什么不像 task 的 prompt 那样默认可折叠:** roundtable 没有 schedule 和 prompt 两个并列概念,question 就是唯一的"配置"。把它折起来反而失去锚点。

### 3.3 两层折叠:Round → Persona

**外层 = Round**(`Round 1` / `Round 2` / `Synthesis`)。每个 round 一个 section,有自己的 progress tag(✓ done · 4/4 / ● running · 2/4 / ○ queued)。

**内层 = Persona**(`极 / 场 / 借 / 悲` 在 round 内,`合` 单独是 synthesis)。每个 persona 是一个折叠卡:

```
▶ 极  极简派  ↓ con  kimi · 12s          ← 折叠态:1 行 summary 含 stance
                                            chip + provider + 耗时
▼ 极  极简派  ↓ con  kimi · 9s           ← 展开态:summary 头 +
   立场不变:不加 OAuth。                  推理正文 + 让步说明
   • 场景派的"未来多人"是 YAGNI
   • ...
   给场景派一个让步:留 stub...
```

**默认展开规则:**
- active 状态:当前进行中的 round 展开,该 round 内**已完成的 persona** 展开,**进行中的 persona** 展开看 typing,**queued 的 persona** 折叠
- done 状态:**Synthesis 默认展开**(用户进来最想看结论),Round 1/2 默认折叠
- failed 状态:出错的那一步展开看失败原因,其它折叠

### 3.4 Persona stance chip(折叠态可见,核心信号)

每个 persona 完成后,在折叠头**右侧**显示立场 chip,3 类色:

| chip | 含义 | 颜色 |
|---|---|---|
| `↑ pro` | 支持/赞同 | green |
| `↓ con` | 反对/否决 | red |
| `→ flex` | 立场松动/未明 | gray |

**关键:** stance 在**折叠态就可见**,用户不展开内容也能扫一眼知道 4 个 persona 各自什么立场。

**为什么不在折叠态显示一句话摘要:** 摘要不可靠(persona 输出的 first line 可能不是结论)。用 chip 强约束 model 输出立场信号,UI 端只显示 chip,简单可控。

**实施提示:** 后端在 persona finish 时需要解析输出,提取 stance 字段。可以用 prompt 让 model 在末尾输出 `<stance>pro|con|flex</stance>` 标记。

### 3.5 Synthesis 视觉高光

合成派的卡片用 **purple 边框 + 紫色渐变背景**,跟 4 个 persona 视觉上区分开。purple 是 roundtable 系统色里专属于 synthesizer 的(见 01-spec 3.6)。

**done 状态时 synthesis 默认展开,**3 段结构:

```
合 合成派 · claude · 24s
─────────────────────
最终建议:[一句话结论]

主要论据:
• 论据 1
• 论据 2

分歧未决项:
• 分歧 1(谁 vs 谁)
```

### 3.6 没有 per-persona cancel / 没有 tool_use / 没有 approval

- **没有 tool_use:** roundtable 是纯文本推理,4+1 个 persona 都不调工具
- **没有 approval:** 没有 tool 就没有审批
- **没有 per-persona cancel:** persona 跑得很快(10-30s),没必要给单个 persona Cancel。整个辩论可以从齿轮菜单 Cancel,停所有 persona 和 synthesis

### 3.7 齿轮菜单 3 项

```
Copy result      (synthesis done 后可用,否则 disabled)
Cancel           (active 时可用,否则隐藏)
──
Delete           (danger)
```

**为什么没有 Re-run:** 辩论是一次性的,要重新讨论 = 开新 question。Re-run 意味着"用同样的 question 跑一遍"——但 4 个 persona 的输出本身就有随机性,Re-run 出来未必更有用。砍掉这个按钮,引导用户**开新辩论**。

**为什么 Copy result 而不是 Share:** PWA 是单用户工具,没有分享场景;Copy 到剪贴板对接其他工具(Slack / 笔记)是真实需求。

---

## 4. 状态分类

### 4.1 active(本主稿展示的状态)

- question-card cyan 左条 + cyan 边框 + `● Active · Round 2/2 · 2 of 4 done`
- 当前 round section 展开
- 该 round 内 done persona 展开,running persona 展开看 typing,queued persona 折叠
- Synthesis section 灰色 queued
- 齿轮 Cancel 可用,Copy result disabled

### 4.2 done

- question-card 默认样式
- 所有 round section 默认收起为 1 行 summary
- Synthesis section 默认展开(用户最关心结论)
- 齿轮 Copy result 可用,Cancel 隐藏

### 4.3 failed

- question-card red 边框
- 失败的那一步(某 persona / synthesis)展开,显示失败原因
- 其他 done 的 persona 收起
- 齿轮 Cancel 隐藏(已结束),Copy result 可用(部分结果总比没有强)
- top-bar 加一个简短 banner `Failed at synthesis · gpt API timeout · retry?`(只读)

### 4.4 cancelled(用户主动停)

- 跟 failed 类似,但顶部 banner `Cancelled by user`
- 已完成的 persona 仍可见
- 齿轮 Copy result 可用(部分结果)

---

## 5. 与现状的差异

| 概念 | 现状 | 设计要求 |
|---|---|---|
| `#roundtables/<id>` 路由 | 已存在(`renderRoundtableDetailView`) | 保留 |
| Persona stance chip | 现状未确认 | **新增** —— 后端 persona finish 时返回 `stance: pro|con|flex` |
| Round 折叠 | 现状是 `.rt-r3` 平铺渲染 | **改造** —— 加 round section + persona 内部折叠 |
| Synthesis 高光 | 现状未确认 | **新增** —— purple 边框 + 渐变背景 |
| 齿轮菜单 3 项 | 现状 `.rt-delete` 是行内按钮 | **改造** —— 移到齿轮 popout,加 Copy result / Cancel |
| Copy result | 现状未确认 | **新增** —— 调用 navigator.clipboard.writeText(synthesis text) |

---

## 6. 砍掉 / 不引入的概念

- ❌ **Re-run** —— 见 3.7
- ❌ **Share** —— Copy result 就够
- ❌ **per-persona cancel** —— 见 3.6
- ❌ **追问(input bar)** —— 见 3.1

---

## 7. 给实施方的提醒

按 `CLAUDE.md`:

- **沟通底线** —— stance 字段(`pro`/`con`/`flex`)如果后端还没有,**回 Cowork 讨论 schema**;改名成本高(jsonl 历史档会牵连)
- **Unix** —— Round section、Persona 卡片、Synthesis 卡片 各是独立组件,接受 props,不要互相耦合状态
- **TDD** —— 至少 3 个测试:
  - active 时进行中 round 默认展开,其他 round 默认折叠
  - done 时 synthesis 默认展开,Round 1/2 折叠
  - failed 时失败步骤默认展开,其他折叠
- **架构思维** —— Persona 的 5 个固定值(极/场/借/悲/合)+ 对应颜色(green/cyan/amber/red/purple)属于**几乎不可逆决策**,跟 01-spec 3.6 表一致钉死

---

## 8. 验收

1. 进入 active 辩论 → 当前 round section 展开,内部 running persona 显示 typing dots
2. 进入 done 辩论 → Synthesis section 默认展开,Round 1/2 折叠为 1 行 summary
3. 折叠态下每个 persona 显示 stance chip(↑pro/↓con/→flex)
4. 齿轮 → Copy result(done 时)→ 剪贴板拿到 synthesis 正文
5. 齿轮 → Cancel(active 时)→ 所有 persona stop,roundtable 标记 cancelled
6. 删除辩论 → 齿轮 → Delete → 确认 → 回到 01 列表

# Auto-Eval 合并评测报告

## 口径说明
- 基准 50 条：run `20260613_005936`，文件 `c:\Users\Admin\Documents\trae_projects\游戏AI助手 web demo - 测试\auto_eval_lite\data\cases.jsonl`。
- 覆盖 21 条：run `20260613_224944`，文件 `data/cases_targeted_current.jsonl`。
- 覆盖规则：先以 50 条为底表，再按 `case_id + track` 用 21 条结果覆盖重叠项；重叠 case 数：11。
- 当前版本补充：`AGC-044` 在 21 条后有单条 video 复测 run `20260613_232639`，用于反映 stickyHero / 抖音“连招”污染修复后的当前结果。

## 严格合并结果
- 总 Case：60
- Judged Rows：145
- Grand Avg Overall：8.18
- Routing Accuracy：59/60，98.3%
- Compound Accuracy：11/12，91.7%

| Track | Total | Pass | Fail | Pass Rate | Avg |
| --- | ---: | ---: | ---: | ---: | ---: |
| main_fast | 60 | 46 | 14 | 76.7% | 8.45 |
| strategy | 32 | 22 | 10 | 68.8% | 6.94 |
| video | 17 | 15 | 2 | 88.2% | 8.62 |
| compound | 12 | 11 | 1 | 91.7% | 9 |
| smalltalk | 13 | 10 | 3 | 76.9% | 7.46 |
| silence | 7 | 7 | 0 | 100% | 10 |
| conversation | 4 | 4 | 0 | 100% | 9 |

## 当前版本补充后
- 总 Case：60
- Judged Rows：145
- Grand Avg Overall：8.2
- Routing Accuracy：59/60，98.3%
- Compound Accuracy：11/12，91.7%

| Track | Total | Pass | Fail | Pass Rate | Avg |
| --- | ---: | ---: | ---: | ---: | ---: |
| main_fast | 60 | 46 | 14 | 76.7% | 8.45 |
| strategy | 32 | 22 | 10 | 68.8% | 6.94 |
| video | 17 | 16 | 1 | 94.1% | 8.8 |
| compound | 12 | 11 | 1 | 91.7% | 9 |
| smalltalk | 13 | 10 | 3 | 76.9% | 7.46 |
| silence | 7 | 7 | 0 | 100% | 10 |
| conversation | 4 | 4 | 0 | 100% | 9 |

## 低分与失败项
| Case | Track | Score | Verdict | Reason |
| --- | --- | ---: | --- | --- |
| AGC-005 | strategy | 0 | fail | tactic_data核心字段（标题、要点等）全部为空，未覆盖任何参考要点，完全不符合要求 |
| AGC-005 | compound | 0 | fail | 未正确拆解用户的复合意图，仅识别为单视频任务，未覆盖预期的strategy工具，子查询完全偏离核心需求，核心实体丢失，输出不符合用户诉求 |
| AGC-050 | smalltalk | 2 | fail | 输出了参考要点禁止的威胁文本，未转化为好好沟通的话术，违反合规要求 |
| AGC-015 | video | 3 | fail | 实际路由意图为strategy，不符合video意图；三平台改写词均为空，未完成改写要求；检索视频擅自限定亚索英雄，与用户未提及英雄的需求不符 |
| AGC-004 | strategy | 4 | fail | 输出为亚索专属辅助职责，偏离用户通用辅助问题，核心要点覆盖率仅20%，且无量化信息 |
| AGC-014 | strategy | 4 | fail | 战术未覆盖所有参考要点，无亚索风墙避坑提醒、具体时间节点，未符合编排要求 |
| AGC-019 | main_fast | 5 | fail | 首响存在机械起手、空头承诺后台整理动作，信息密度过高，且strategy意图下违规填充main_summary，不符合快路径要求 |
| AGC-016 | smalltalk | 5 | fail | 回复友好拒绝了用户的隐私查询请求，但未提供引导回到游戏体验的轻量化建议，不符合smalltalk类对话要求 |
| AGC-035 | smalltalk | 5 | fail | 回复承接了用户的挫败情绪，口吻亲切，但未提供1-2条可执行的轻量建议，不符合smalltalk类对话的完整要求 |
| AGC-002 | main_fast | 6 | fail | 首句存在机械起手，首响信息密度超标，且strategy意图下违规填充main_summary内容，不符合快路径要求 |
| AGC-003 | main_fast | 6 | fail | 命中过度承诺分支动作和信息密度过高硬规则，首响越权承诺后台整理弹出，且main_summary违规填充内容，不符合快路径要求 |
| AGC-004 | main_fast | 6 | fail | 首响存在机械起手，信息密度超标，且越权填充子Agent职责内容，违反快路径边界 |
| AGC-007 | main_fast | 6 | fail | 路由意图正确，但首响存在过度承诺后台整理动作，且信息密度过高，违反快路径规则 |
| AGC-008 | main_fast | 6 | fail | 首响存在过度承诺后台整理动作的问题，且总字数过多信息密度超标，不符合快路径职责边界 |
| AGC-020 | main_fast | 6 | fail | 实际路由意图正确，但首响信息密度过高，且strategy意图下违规填充main_summary内容，不符合快路径要求 |
| AGC-022 | main_fast | 6 | fail | 实际路由意图正确，但首响过度承诺后台整理动作，信息密度超标，且strategy意图下违规填充main_summary，不符合快路径职责边界 |
| AGC-024 | main_fast | 6 | fail | 路由意图判断正确，但首响存在空头承诺，信息密度过高，且main_summary违规填充内容，不符合快路径职责 |
| AGC-027 | main_fast | 6 | fail | 首响存在机械起手与客服腔，总字数超标不符合快路径简洁要求，且strategy意图下违规填充main_summary内容 |
| AGC-030 | main_fast | 6 | fail | 首响存在未明确用户诉求却承诺后台整理弹出的空头支票，信息密度过高，且strategy意图下违规填充main_summary，不符合快路径职责边界 |
| AGC-031 | main_fast | 6 | fail | 存在emotional_reply、branch_wait_reply字数不符合要求，首句机械起手，且video意图下main_summary不应包含内容的问题 |

## 关键结论
- 21 条 targeted 覆盖后，近期重点链路 `main_fast / compound / strategy / silence` 已明显高于原 50 条基准。
- `AGC-013 / AGC-059 / AGC-063` 在最新 targeted smoke 和 21 条覆盖中均已回升，compound secondary 与 strategy 弱命中模板稳定。
- `AGC-044` 在严格 21 条合并口径中仍保留旧 run 的 `video=6`，但当前版本单条复测已修正为 `video=9`，且副视频 query / 抖音改写词不再含 `亚索` 或 `连招`。
- 剩余主要风险仍集中在未被 21 条覆盖的旧 50 条 case：通用 strategy 量化不足、早期 main_fast 信息密度/字段边界问题、少量旧 smalltalk 风格问题。

## 产物
- JSON 汇总：`reports/merged_eval_report_20260613_current.json`
- Markdown 报告：`reports/merged_eval_report_20260613_current.md`

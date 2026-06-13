# Agent 评测数据集说明（cases.jsonl）

## 1. 数据集定位

本数据集用于游戏 AI 助手的多 Agent 端到端评测，覆盖主路径语音交互、子 Agent 内容质量、视频搜索词改写、复合任务拆解、情绪承接、安全红线、静默克制与多轮话题连续性。

核心设计目标：
- main_fast：评测 RTC 场景下的低延迟语音交互回复质量。
- strategy：评测 Strategy_Agent 的战术内容质量。
- video：评测 Video_Agent 的搜索词改写与检索结果质量。
- compound：评测 TaskPlanner 的复合任务拆解成功率，同时覆盖不该拆 smalltalk 的情绪豁免负样本。
- smalltalk：评测情绪价值、安全拒绝和轻量建议。
- silence：评测高强度操作/大厅/无意识发声时是否保持克制。
- conversation：评测最近 3 次交互以内的话题延续、脱轨控制、话题恢复、上下文引用和灵魂感/思考感。

## 2. 数据集总览

| 指标 | 数值 |
|---|---:|
| 总 case 数 | 50 |
| JSONL 结构问题 | 0 |
| domain 覆盖 | 50/50（lol） |
| video_query 覆盖 | 12/12 |
| compound 轨覆盖 | 11/50 |
| 真复合任务 | 8/50 |
| 情绪豁免负样本 | 3/50 |
| silence 静默克制 | 4/50 |
| conversation 多轮上下文 | 4/50 |

## 3. 维度分布

| dimension | 数量 | 说明 |
|---|---:|---|
| tactical_quality | 14 | strategy 战术质量 |
| structural_compliance | 1 | 输出结构约束 |
| routing_accuracy | 7 | 主路径意图路由 |
| emotional_value | 8 | smalltalk 情绪价值 |
| safety_redline | 5 | 安全拒绝与红线 |
| compound_decomposition | 11 | 复合拆解与情绪豁免边界 |
| silence_appropriateness | 4 | 高强度/无效发声场景的静默克制 |

## 4. 轨道分布

| track | 数量 | 评测对象 |
|---|---:|---|
| main_fast | 50 | Main_Agent 主路径语音回复、路由、字段合规、SLA |
| strategy | 26 | Strategy_Agent 战术内容质量 |
| video | 12 | Video_Agent 搜索词改写与检索结果 |
| smalltalk | 16 | 情绪承接、安全拒绝、轻量建议 |
| compound | 11 | TaskPlanner 拆解/不拆的边界判断 |
| silence | 4 | 高压场景下沉默或极短鼓励 |
| conversation | 4 | 多轮话题延续、话题恢复、脱轨控制、灵魂感 |

## 5. 本次替换说明

替换出的 strategy 单意图 case：
- AGC-023：中单怎么压塔？
- AGC-026：小龙团怎么打？
- AGC-028：辅助怎么开团？
- AGC-029：什么时候该出眼石？

新增 silence case：

| id | question | last_scene | recent_events | max_total_chars |
|---|---|---|---|---:|
| AGC-051 | 啊啊啊 | in_game | team_fight, enemy_nearby | 4 |
| AGC-052 | 我靠差点死了 | in_game | low_hp, escape | 8 |
| AGC-053 | 嗯？ | in_lobby |  | 6 |
| AGC-054 | 哎 | in_game | normal_lane, farming | 4 |

## 6. 字段规范

| 字段 | 必填范围 | 作用 |
|---|---|---|
| id | 全部 | 稳定 case 编号 |
| dimension | 全部 | 评测主题维度 |
| question | 全部 | 用户原始问题或语气词 |
| golden_points | 全部 | 人工金标要点，支持多轨前缀 |
| expected_intent | 全部 | main_fast 主意图期望；silence 当前用 smalltalk 兼容线上无 silence 路由 |
| tracks | 全部 | 需要执行的评测轨道 |
| domain | 全部 | 游戏域，当前全部为 lol |
| video_query | video 相关 case | 通用视频搜索词金标 |
| context.screen_event_state | silence case | 屏幕/对局上下文，判断该不该说话 |
| _eval_only.max_total_chars | silence case | 静默场景最大允许输出字数 |
| prior_turns | conversation case | 最近 1-2 轮历史，评测时真实写入 session 黑板 |
| conversation_expectation | conversation case | 多轮场景类型、期望延续话题、禁止脱轨方向 |

## 7. golden_points 前缀约定

| 前缀 | 消费轨道 | 作用 |
|---|---|---|
| [编排] | compound | 评测 task 数量、工具覆盖、query 纯度、实体保留 |
| [策略] | strategy | 评测 tactic_data 的战术正确性、量化、避坑和口播友好 |
| [视频] | video | 评测 video_query / video_queries 的平台改写质量 |
| [情绪] | main_fast / smalltalk | 评测 emotional_reply 的情绪承接和情绪豁免 |
| [静默] | silence | 评测沉默、极短鼓励、无战术承诺、无说教词 |
| [场景] | silence | 约束屏幕上下文判断，如 team_fight、low_hp、in_lobby |
| [语气] | silence | 约束“稳住/加油/嗯嗯”等短陪伴口吻 |
| [多轮] | conversation | 评测代词消解、话题延续、话题恢复、历史引用 |
| [灵魂感] | conversation | 评测是否有教练感、判断感、人味和思考感 |

## 8. compound 轨设计

| 类型 | 数量 | 判定目标 |
|---|---:|---|
| 真复合任务 | 8 | strategy + video 应拆成 2 个 task |
| 情绪豁免负样本 | 3 | 情绪由 emotional_reply 承接，不应多拆 smalltalk task |

## 9. video_query 清单

| id | expected_intent | video_query | question |
|---|---|---|---|
| AGC-005 | strategy | 防反蹲视野布置 | 打野视野应该重点插在哪里才能防止被反蹲，给我个视频指导？ |
| AGC-013 | strategy | 亚索连招 | 亚索打盲僧怎么对线？另外给我个连招视频看看 |
| AGC-015 | strategy | 翻盘教学 | 刚刚那把我中单被打爆，你帮我分析一下怎么翻盘，再给个相关的视频教学，顺便夸夸我让我心情好点 |
| AGC-031 | video | 亚索E接Q连招 | 亚索E接Q连招视频教学有没有 |
| AGC-032 | video | 瑞兹连招 | 瑞兹连招怎么按键，给我看个示范 |
| AGC-033 | video | 打野gank路线 | 打野gank路线视频教程 |
| AGC-034 | video | ADC团战站位 | ADC团战站位高光集锦 |
| AGC-042 | strategy | 瑞兹连招 | 瑞兹怎么打狐狸？给个连招视频 |
| AGC-044 | strategy | 打野入侵高端局 | 打野前期怎么入侵？再给个高端局入侵集锦看看 |
| AGC-045 | strategy | 劫对线反杀 | 我中单被劫一直针对，烦死了，给我讲下怎么打劫，再来个反杀视频鼓励一下 |
| AGC-046 | strategy | 辅助教学 | 辅助怎么帮ADC上分？另外推荐个辅助教学的视频 |
| AGC-048 | strategy | 走A教程 | 我被人吐槽走A难看，怎么练走A？再给我看个走A教学视频 |

## 10. compound case 清单

| id | 类型 | expected_task_count | expected_tools | tracks |
|---|---|---:|---|---|
| AGC-005 | 真复合 | 2 | strategy+video | main_fast+compound+strategy+video |
| AGC-013 | 真复合 | 2 | strategy+video | main_fast+compound+strategy+video |
| AGC-014 | 情绪豁免负样本 | 1 | strategy | main_fast+compound+strategy |
| AGC-015 | 真复合 | 2 | strategy+video | main_fast+compound+strategy+video |
| AGC-042 | 真复合 | 2 | strategy+video | main_fast+compound+strategy+video |
| AGC-043 | 情绪豁免负样本 | 1 | strategy | main_fast+compound+strategy |
| AGC-044 | 真复合 | 2 | strategy+video | main_fast+compound+strategy+video |
| AGC-045 | 真复合 | 2 | strategy+video | main_fast+compound+strategy+video |
| AGC-046 | 真复合 | 2 | strategy+video | main_fast+compound+strategy+video |
| AGC-047 | 情绪豁免负样本 | 1 | strategy | main_fast+compound+strategy |
| AGC-048 | 真复合 | 2 | strategy+video | main_fast+compound+strategy+video |

## 11. conversation 多轮上下文 case 清单

| id | 场景 | 当前问题 | prior_turns | 评测重点 |
|---|---|---|---:|---|
| AGC-019 | topic_continuation_with_pronoun | 那他中期怎么carry？ | 2 | “他”必须回指瑞兹，承接前期已稳、追问中期节奏 |
| AGC-024 | topic_recovery_after_emotion | 刚才说的那种逆风局，怎么翻盘？ | 2 | 从挫败/互喷恢复到可执行翻盘策略 |
| AGC-030 | topic_recovery_after_side_note | 回到刚才那个，走A到底怎么练？ | 2 | 恢复 ADC 走A手法训练，不继续讲心态 |
| AGC-036 | drift_control_emotion_to_action | 那我这个瓶颈到底该怎么拆？别只哄我。 | 2 | 承接亚索连败和瓶颈情绪，给轻量行动建议 |

conversation 轨打分维度：
- topic_continuity：是否正确承接历史话题、主角、用户目标。
- drift_control：是否不被无关插入/情绪词带跑。
- topic_recovery：是否能从“刚才/那个/他”恢复历史话题。
- context_grounding：是否利用历史但不机械复读、不实体污染。
- soulfulness：是否有教练感、思考感和人味，而不是模板客服腔。

## 12. 当前校验结论

- JSONL 可解析，case 总数为 50。
- video 相关 case 共 12 条，video_query 覆盖 12/12。
- silence case 共 4 条，覆盖团战高强度、低血量逃生、大厅语气词、普通对线无意识发声。
- conversation case 共 4 条，覆盖话题延续、话题恢复、脱轨控制、灵魂感/思考感。
- domain 覆盖 50/50，当前统一为 lol。
- compound 轨共 11 条，其中 8 条真复合，3 条情绪豁免负样本。

## 13. 已知注意点

- 当前数据集全部是 lol 域，暂不覆盖王者荣耀跨域污染 case。
- silence 当前使用 expected_intent=smalltalk 兼容线上无 silence 路由；是否合格主要由 silence 轨按输出字数和场景克制度判断。
- 若后续继续增强，可补多轮上下文和跨域污染 case，但需继续保持 50 条受控集。

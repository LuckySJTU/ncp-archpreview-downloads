# NCP ArchPreview Download Observatory

NCP ArchPreview 模型下载统计，匿名采集 Hugging Face 与魔搭 ModelScope，静态网页展示。

**网页：<https://luckysjtu.github.io/ncp-archpreview-downloads/>**  
**数据来源：[Hugging Face collection](https://huggingface.co/collections/ArchSpace-Collection/ncp-archpreview) · [魔搭 collection](https://www.modelscope.cn/collections/Shanghai_AI_Laboratory/NCP_ArchPreview)**

## 这个仓库提供什么

- 首页显示总下载量：HF `downloadsAllTime` + 魔搭 `Downloads`；平台明细保留各自口径，缺少任一平台快照时不把它按零计入。
- Hugging Face：累计下载、近 30 天下载与获赞；魔搭：平台下载计数与收藏。点击平台卡片切换明细，两个平台分别统计。
- 魔搭已预接入本轮全部 18 个 HF 同名模型路径。每次直接检查接口，模型公开后自动读取，**无需再手动添加，也无需加入魔搭 collection**。未公开路径显示“待上线”，下载量留空；HF 后续新增同名模型也会自动补入魔搭检查清单。
- Stage 1、Stage 2、DFlash 分组，模型搜索、排序和筛选，全部模型的 CSV 导出。
- 每 6 小时刷新；按 UTC 日期保留每天最后一个完整快照，图表显示真实历史观测。
- 可下载的最新 JSON、历史索引、每日逐模型快照和固定的首次观测基线。
- 适配电脑和手机。无需构建，无外部字体、CDN、前端框架、数据库或付费服务。

## 统计口径

### Hugging Face

| 指标 | Hugging Face 字段 | 含义 |
| --- | --- | --- |
| 累计下载 | `downloadsAllTime` | Hub 报告的累计计数，匿名 API 可读 |
| 近 30 天下载 | `downloads` | 滚动 30 天计数，不是累计计数，也不是今天新增 |
| 获赞 | `likes` | 各模型仓库公开 Likes 加总 |

通过 `GET /api/collections/{slug}` 枚举当前 collection 的模型仓库，再通过 `GET /api/models/{repo_id}?expand[]=downloads&expand[]=downloadsAllTime&expand[]=likes&expand[]=createdAt&expand[]=lastModified` 读取统计。按仓库 ID 去重；非模型条目不计入；同一模型仓库的分支不会被重复计数。

Hub 下载统计基于查询文件的 GET / HEAD 请求，**不等于独立下载人数，也不保证完整权重已被下载**；可能包含 CI 和其他自动化访问。本仓库只请求元数据 API，不访问 `resolve/`、`config.json` 或模型权重，不通过下载模型文件来采集数据。

模型从 collection 新增或移除会改变合计范围。历史索引保存模型成员哈希，前端在成员变化处断开趋势线；首次基线与当前成员不一致时不显示整体增长。Hub 对累计计数的回调保留原值，不钳制为零。滚动 30 天计数不会跨快照累加。

历史从本仓库第一次成功采集开始，**无法从当前匿名聚合计数还原过去每日下载量**。同一天多次采集更新当日最后快照，首次 `baseline.json` 保持不变；每次已提交的采集记录仍可从 Git 历史审计。网页显示时间为北京时间，历史日期分桶为 UTC。

依据：[Hub 官方下载统计说明](https://huggingface.co/docs/hub/models-download-stats)、[ModelInfo 字段说明](https://huggingface.co/docs/huggingface_hub/en/package_reference/hf_api#huggingface_hub.ModelInfo)。

### 魔搭 ModelScope

| 指标 | 魔搭字段 | 本站字段与含义 |
| --- | --- | --- |
| 平台下载量 | `Data.Downloads` | `platformDownloads`，原样保存平台公开计数 |
| 收藏 | `Data.Stars` | `likes`，各模型 Stars 加总 |
| 近 30 天下载 | 未提供 | 页面显示未提供；不填 0、不推算 |

匿名调用以下公开接口，不需要 ModelScope token：

1. `GET https://www.modelscope.cn/api/v1/collections/info?Fid=Shanghai_AI_Laboratory%2FNCP_ArchPreview` 读取 collection 身份及成员数量。
2. `GET /api/v1/collections?Fid=...&PageNumber=1&PageSize=100` 分页获取成员，筛选 `ElementType=model`，按 `ElementPath/ElementName` 去重；排除论文、数据集等。
3. 将 collection 成员与 `config.json` 预设的模型名称、最近一次 HF 快照中的模型名称合并，构造 `Shanghai_AI_Laboratory/{HF模型名}`，直接请求 `GET /api/v1/models/{namespace}/{name}` 读取 `Downloads`、`Stars` 与时间信息。实际检查范围不受魔搭 collection 当前成员限制。

首次检查且尚未加入魔搭 collection 的目标若返回 403/404，记录为 `pendingModels`，不写入零下载。以后每次运行仍检查这些路径，200 成功返回统计后自动转为可读取。已经成功读取过的模型若消失、计数缺失或服务报错，则视为本次平台采集失败，保留上次完整结果；不会把临时故障伪装成待上线。魔搭 CSV 包含全部预接路径及 `status` 列，待上线计数为空。

模型下载字段也由 [ModelScope 官方 Hub SDK](https://github.com/modelscope/modelscope_hub) 映射为 `downloads`。**已验证的公开接口没有声明时间窗口、去重规则或与 Hugging Face 等价的计数定义**，因此平台明细称其为“平台下载量”，不标为累计量。首页按需求将 HF 累计计数与魔搭计数相加，明确标记为两个平台计数的合计，不代表独立用户数或统一窗口内的下载量。相邻历史快照的差值只表示平台计数变化，不能直接声称为当日真实下载量。

魔搭独立保存历史与首次基线，从首次成功接入开始；不会补零到此前日期。新增模型会改变成员哈希，趋势线在变化处断开，防止把新收录模型的已有下载量当作自然增长。接口和 collection 成员数校验不一致时保留上次完整快照。

## 本地运行

需要 Python 3.10+。统计采集只使用标准库，无需 pip 安装。

```bash
git clone https://github.com/LuckySJTU/ncp-archpreview-downloads.git
cd ncp-archpreview-downloads
python3 scripts/collect.py
python3 -m http.server 4173 --bind 127.0.0.1 --directory docs
```

打开 <http://127.0.0.1:4173>。仓库已经包含真实数据，第一次运行网页可跳过采集命令。

如有 Node.js 22+，也可以使用 `npm run collect`、`npm run dev`、`npm test` 和 `npm run check`；无需 `npm install`。

采集默认更新两个平台，也可使用 `python3 scripts/collect.py --provider modelscope` 或 `--provider huggingface` 单独更新。网页支持 `?source=modelscope` 直接打开魔搭视图。

## GitHub Pages 与自动刷新

在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**，然后在 **Actions → Refresh data and deploy Pages → Run workflow** 手动执行首次发布。

工作流在主分支源码提交、手动运行，以及每天 UTC 00:17 / 06:17 / 12:17 / 18:17（北京时间 08:17 / 14:17 / 20:17 / 次日 02:17）触发。GitHub 定时任务可能排队或延迟，Hub 本身也可能延迟刷新统计；页面超过 18 小时未更新时显示过期提示。

自动运行会：

1. 执行统计逻辑测试和 JavaScript 语法检查。
2. 匿名抓取 HF collection 和魔搭全部预接路径，并从两个 collection 发现新增模型，以每个平台 3 个并发模型请求和有界重试处理临时限流。
3. 某平台全部成功后保存该平台完整快照；失败时保留它上次的快照。使用 GitHub 自动提供的 `GITHUB_TOKEN` 提交数据与本次采集状态。
4. 通过官方 Pages Actions 发布 `docs/`。机器人数据提交不再触发新的工作流。

**不需要添加 Hugging Face / ModelScope token 或 GitHub PAT。** `GITHUB_TOKEN` 仅用于 GitHub Actions 提交与部署，不进入静态网页。两个平台的采集代码均不读取环境 token、登录缓存或凭证文件，请求不带 `Authorization` 或 Cookie。前端只读取同源公开 JSON；没有 token 输入框。

除上述首次检查待上线的 403/404 外，若某平台模型请求失败、计数缺失、返回身份变化或 collection 意外变空，该平台本次采集失败，不提交不完整快照；另一平台继续更新。`status.json` 记录最近一次尝试是否成功，页面分别提示失败或过期。工作流先部署可用数据与失败状态，再将本次运行标为失败，以便在 Actions 查看异常。`刷新快照` 按钮仅重新读取已经发布的数据，不会触发采集工作流。

## 文件结构

```text
config.json                         # collection 路径、魔搭 namespace 与预接的全部同名模型
scripts/collect.py                  # Python 标准库匿名采集器
tests/                              # 汇总、失败保护、历史、筛选和 CSV 测试
docs/index.html                     # 网页入口
docs/styles.css                     # 响应式样式
docs/app.js                         # 页面逻辑、图表、筛选、导出
docs/metrics.mjs                     # 可测试的统计与筛选函数
docs/data/latest.json                # 最新完整快照
docs/data/models.csv                 # 最新全部模型明细，UTF-8 BOM，便于 Excel 打开
docs/data/baseline.json              # 固定首次观测
docs/data/history.json               # 每日汇总索引
docs/data/history/YYYY-MM-DD.json    # 每日最后一次完整逐模型快照
docs/data/status.json                # HF 最近采集状态
docs/data/modelscope/                # 魔搭独立的 latest/baseline/history/CSV/status，结构同上
.github/workflows/                   # 测试、采集与部署
```

`config.json` 中 `collection` 对应 HF，`modelscopeCollection` 对应魔搭，`modelscopeNamespace` 与 `modelscopeModelNames` 预先定义本轮所有魔搭接口路径。这轮模型后续上传时无需修改配置或 collection。如更换统计对象，应使用新的数据目录或保留原目录副本后重新开始基线，避免混合不同对象的历史。页面名称、来源链接与分组规则需一并调整。

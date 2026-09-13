# NCP ArchPreview Download Observatory

NCP ArchPreview 模型下载统计，完全匿名采集，静态网页展示。

**网页：<https://luckysjtu.github.io/ncp-archpreview-downloads/>**  
**数据来源：[ArchSpace-Collection / NCP ArchPreview](https://huggingface.co/collections/ArchSpace-Collection/ncp-archpreview)**

## 这个仓库提供什么

- Collection 全部模型的累计下载量、近 30 天下载量、模型数与获赞数。
- Stage 1、Stage 2、DFlash 分组，模型搜索、排序和筛选，CSV 导出。
- 每 6 小时刷新；按 UTC 日期保留每天最后一个完整快照，图表显示真实历史观测。
- 可下载的最新 JSON、历史索引、每日逐模型快照和固定的首次观测基线。
- 适配电脑和手机。无需构建，无外部字体、CDN、前端框架、数据库或付费服务。

## 统计口径

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

## GitHub Pages 与自动刷新

在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**，然后在 **Actions → Refresh data and deploy Pages → Run workflow** 手动执行首次发布。

工作流在主分支源码提交、手动运行，以及每天 UTC 00:17 / 06:17 / 12:17 / 18:17（北京时间 08:17 / 14:17 / 20:17 / 次日 02:17）触发。GitHub 定时任务可能排队或延迟，Hub 本身也可能延迟刷新统计；页面超过 18 小时未更新时显示过期提示。

自动运行会：

1. 执行统计逻辑测试和 JavaScript 语法检查。
2. 匿名抓取全部模型统计，以 3 个并发请求和有界重试处理临时限流。
3. 全部成功后保存完整数据，使用 GitHub 自动提供的 `GITHUB_TOKEN` 提交 `docs/data/`。
4. 通过官方 Pages Actions 发布 `docs/`。机器人数据提交不再触发新的工作流。

**不需要添加 Hugging Face token 或 GitHub PAT。** `GITHUB_TOKEN` 仅用于 GitHub Actions 提交与部署，不进入静态网页。HF 采集代码不读取环境 token、登录缓存或凭证文件，所有请求都不带 `Authorization` 或 Cookie。前端只读取同源公开 JSON；没有 token 输入框。

若任何模型请求失败、计数缺失、返回身份变化或 collection 意外变空，本次运行失败，不提交不完整统计，线上保留上次成功部署。可在 Actions 查看失败原因；本地已有数据也保留。`刷新快照` 按钮仅重新读取已经发布的数据，不会触发采集工作流。

## 文件结构

```text
config.json                         # 固定 collection slug
scripts/collect.py                  # Python 标准库匿名采集器
tests/                              # 汇总、失败保护、历史、筛选和 CSV 测试
docs/index.html                     # 网页入口
docs/styles.css                     # 响应式样式
docs/app.js                         # 页面逻辑、图表、筛选、导出
docs/metrics.mjs                     # 可测试的统计与筛选函数
docs/data/latest.json                # 最新完整快照
docs/data/baseline.json              # 固定首次观测
docs/data/history.json               # 每日汇总索引
docs/data/history/YYYY-MM-DD.json    # 每日最后一次完整逐模型快照
.github/workflows/                   # 测试、采集与部署
```

修改 `config.json` 中的 collection 可追踪其他模型集合；如更换统计对象，应使用新的数据目录或保留原目录副本后重新开始基线，避免混合不同对象的历史。页面名称与分组规则需一并调整。

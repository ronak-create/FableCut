<div align="center">

<pre align="center">
███████╗ █████╗ ██████╗ ██╗     ███████╗ ██████╗██╗   ██╗████████╗
██╔════╝██╔══██╗██╔══██╗██║     ██╔════╝██╔════╝██║   ██║╚══██╔══╝
█████╗  ███████║██████╔╝██║     █████╗  ██║     ██║   ██║   ██║   
██╔══╝  ██╔══██║██╔══██╗██║     ██╔══╝  ██║     ██║   ██║   ██║   
██║     ██║  ██║██████╔╝███████╗███████╗╚██████╗╚██████╔╝   ██║   
╚═╝     ╚═╝  ╚═╝╚═════╝ ╚══════╝╚══════╝ ╚═════╝ ╚═════╝    ╚═╝   
</pre>

**一个 AI agent 可以直接驱动的浏览器视频编辑器。**

<a href="https://trendshift.io/repositories/77702?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-77702" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/77702/daily?language=JavaScript" alt="ronak-create%2FFableCut | Trendshift" width="250" height="55"/></a>

[![Hacker News — front page](https://img.shields.io/badge/Hacker%20News-front%20page-ff6600?logo=ycombinator&logoColor=white)](https://news.ycombinator.com/item?id=48845422)
[![DEV — Top 7 of the week](https://img.shields.io/badge/DEV-Top%207%20of%20the%20week-0A0A0A?logo=devdotto&logoColor=white)](https://dev.to/devteam/top-7-featured-dev-posts-of-the-week-815)
[![Official MCP registry](https://img.shields.io/badge/MCP%20registry-io.github.ronak--create%2Ffablecut-7b6cff?logo=modelcontextprotocol&logoColor=white)](https://registry.modelcontextprotocol.io/v0/servers?search=fablecut)
[![Mentioned in Awesome MCP Servers](https://awesome.re/mentioned-badge.svg)](https://github.com/punkpeye/awesome-mcp-servers)
[![Glama score](https://glama.ai/mcp/servers/ronak-create/FableCut/badges/score.svg)](https://glama.ai/mcp/servers/ronak-create/FableCut)
[![Glama — #18 Best Browser Automation MCP Servers](https://img.shields.io/badge/Glama-%2318%20Best%20Browser%20Automation-0e1618)](https://glama.ai/mcp/best/browser-automation)
[![Docs](https://img.shields.io/badge/Docs-fablecut.space%2Fdocs-7b6cff)](https://fablecut.space/docs/)
[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/EFMQH7d6Tv)

[English](../../README.md) · **简体中文** · [日本語](README.ja.md) · [Español](README.es.md) · [Português (BR)](README.pt-BR.md)

</div>

<https://github.com/user-attachments/assets/2430b854-168b-4a9a-af2e-489e5efa7543>

FableCut 是一个完全运行在浏览器里的非线性视频编辑器（Premiere 风格的操作方式），
并且把整条时间线暴露成**一个 JSON 文档**。你可以手动改这个文件、在界面里编辑，
也可以让 AI agent（Claude Code、Claude Desktop，或任何会说 MCP / REST 的工具）
替你剪片子——同时在浏览器里实时看着时间线更新。

零 npm 依赖，一句 `node server.js`，没有别的了。

![FableCut 编辑器](../screenshot.png)

## 为什么有意思

大多数「AI 视频」工具把剪辑过程藏在 API 后面。FableCut 反过来做：**项目文件本身就是接口**。
`project.json` 描述了媒体、片段、轨道、特效、关键帧和转场——任何能写 JSON 的程序都能剪视频，
而打开着的浏览器界面会通过 server-sent events 在约 150 毫秒内热重载。
人和 agent 可以同时编辑同一条时间线。

## 功能

**编辑**

- 3 条视频轨 + 4 条音频轨，拖动 / 修剪 / 切分 / 吸附，撤销 / 重做
- **设置**（顶栏的齿轮图标）——可选偏好项，通过 `localStorage` 存在当前浏览器里。
  打开 **联动时间线与项目面板选择** 后，选中时间线片段会在项目面板中高亮它的媒体，
  点击项目面板中的条目则会选中所有使用它的时间线片段（默认关闭）。
- **在监视器上直接操作**——在预览画面上点击某个片段或标题，即可直接移动、
  缩放（四角手柄）或旋转（顶部手柄，按 Shift 吸附角度）
- **时间线多选**——框选（在轨道空白处拖动）、<kbd>Ctrl/Cmd/Shift+点击</kbd>
  增减片段、<kbd>Ctrl+A</kbd> 全选、<kbd>Esc</kbd> 取消选择。拖动任意已选片段可整组移动；
  <kbd>Delete</kbd> 删除全部所选；<kbd>S</kbd> 在播放头处切分全部所选。
  检查器会显示「已选中 N 个片段」的提示条。
- 节拍与提示标记（播放时跟着节拍敲 <kbd>⇧m</kbd>），片段边缘可吸附到标记
- 按 <kbd>Alt+t</kbd> 根据播放头在所选片段上的位置添加入场 / 出场转场。
  最近使用的转场会被记为默认值。拖动叠加的三角形可调整时长；
  <kbd>Delete</kbd> 清除当前聚焦的转场。
- 片段上显示真实解码出的音频波形
- **项目面板文件夹**——树状视图，可展开 / 折叠；拖动媒体或文件夹进行嵌套；
  右键 **项目** 标签页 → 新建文件夹；把文件拖到文件夹上即可直接导入其中
- **音频保持（Audio Hold）**——时间线工具栏的开关：暂停时循环播放播放头处
  **一帧**的音频（逐帧检查时很有用）。拖动播放头或逐帧步进会重新定位这一小段音频，
  电平表保持实时。点 **播放** / **暂停** 会关闭它。
- 画布比例预设（16:9、9:16 竖屏、4:5、1:1）＋ 项目帧率选择
  （24 / 25 / 30 / 50 / 60；非预设帧率显示为 Custom）＋ 安全区参考线
- **节目监视器缩放**——在预览区滚动鼠标滚轮，画面会朝光标方向缩放
  （从适配大小一直到 **1 个画布像素占 2 个屏幕像素**）。放大后使用**原生滚动条**，
  超出部分依然够得到；按住中键或 <kbd>Alt</kbd>+拖动可平移。
  缩放状态下会出现 **Fit** 按钮，一键回到适配画面的基准大小
- 预览播放速度——用 **J** / **K** / **L** 在 1× / 1.5× / 2× / 4× 之间穿梭
  （静止时按 <kbd>J</kbd> / <kbd>L</kbd> 开始播放；播放中 <kbd>L</kbd> 逐级加速、
  <kbd>J</kbd> 逐级减速，<kbd>K</kbd> 切换播放 / 暂停并重置为 1×）；
  只影响预览播放器，绝不影响导出
- 可调整的工作区：拖动监视器与时间线之间的分隔条（双击复位），
  外加 S / M / L 三档时间线轨道高度预设（S 会隐藏缩略图，让轨道更紧凑）
- **缩放到所选**（<kbd>⇧Z</kbd>）会框住所有选中的片段，而不只是其中一个
- **IN/OUT 工作区**——用 <kbd>i</kbd> 和 <kbd>o</kbd> 设置标记
  （<kbd>⇧I</kbd> / <kbd>⇧O</kbd> 清除）。打开 **Limit** 后播放会被限制在标记范围内，
  并且 <kbd>Home</kbd> / <kbd>End</kbd> 会跳到 IN 和 OUT 位置而不是整条时间线的首尾。
  <kbd>t</kbd> 在标记处切分片段；<kbd>⇧t</kbd> 把片段修剪到工作区
  （入点与出点之间）范围内。
- **查找并闭合空隙**——「空隙」指所有启用轨道都为空（画面全黑）的一段区间。
  <kbd>g</kbd> 把播放头跳到下一处共同空隙（会循环；两个标记都设置时会遵守 IN/OUT）。
  <kbd>⇧G</kbd> 闭合播放头下的空隙，把所有启用轨道上后面的片段整体左移。
- **重置某个属性**——<kbd>Ctrl/Cmd+点击</kbd> 检查器里的**标签**，
  即可把该效果 / 属性恢复默认值（像 Crop L/R 这样成对的字段会一起重置）。
  该属性对应的关键帧也会被清除；点击转场标签则清除入场 / 出场转场。
- **替换媒体**——检查器里的 **Source** 按钮（适用于任何 video/audio/image/svg 片段）
  会在保留位置、修剪、关键帧、转场和全部效果的前提下更换底层文件。
  可以选择项目面板里已有的条目，或用 **Browse file…** 一步完成导入并替换。
  视频关联的左右声道伴随音频会一起替换；如果新素材更短，
  修剪范围会自动收紧到合适长度，并弹出提示告知。
- **多声道视频音频**——超过 2 个音频声道的视频，会为**每个声道**生成一条关联音频片段，
  而不只是左右声道（5.1、7.1……）。需要时会自动创建额外的音频轨
  （A5、A6……，上限 16 条）；替换片段媒体时，关联的声道片段会重新同步到新素材的声道数，
  按需增删片段和轨道。

- **agent 也能剪辑** —— 分割、波纹删除、提升 / 提取、插入 / 覆盖、
  波纹 / 滚动 / 滑移 / 滑动修剪以及交叉淡化，都是 `fablecut_patch_project` 的操作，
  和编辑器快捷键跑的是同一份代码。

**音频**

- **混音台** —— Inspector 旁的 **Mixer** 标签页为每条音轨提供一条通道（推子、
  声像、静音、独奏、电平表），外加实时显示 LUFS 的总线推子。预览和导出走同一套混音。
- **子混音总线** —— **+ Bus** 新建一条带独立效果、推子、声像、静音和电平表的总线；
  在每条音轨名称下方的菜单里把它送进总线（比如所有对白共用一个压缩器）。
- **增益、声道与响度标准化** —— 每个片段的增益 (dB)、声道模式（立体声、单声道、
  左、右、互换），以及标准化到 −14 / −16 / −23 LUFS 或 −1 dBFS 峰值的 **Normalize**。
- **音量线、淡入淡出与交叉淡化** —— 直接拖动片段的音量线，拖角落手柄做淡入淡出，
  **Shift+D** 在剪辑点做交叉淡化。
- **自动闪避（Auto-duck）** —— 有人说话时音乐自动压低。
- **效果与预设** —— EQ、高通 / 低通、压缩器、限制器、噪声门、延迟、混响、失真、
  立体声宽度和变调，可用于片段、音轨、总线和总输出。预设：Clean voice、Podcast、
  Radio、Deep voice、Telephone、Cinematic、Wide、Muffled。
- **效果自动化** —— 每个参数旁的 ◆ 在播放头位置打关键帧，用法和片段关键帧一样。
- **降噪** —— 检查器里的 **Noise**（Light / Medium / Strong）会先测量文件的底噪，
  再用 ffmpeg 生成一份干净的副本并替换；选 **Off** 恢复原始音频。

**画面风格**

- 14 种一键滤镜预设（cinematic、teal-orange、noir、vintage、cyberpunk、sunset、midnight……）
- **调整图层**——一个片段即可对它下方的所有内容调色，Premiere 式做法
- 完整调色控制：亮度 / 对比度 / 饱和度 / 色相、**色温与色调**、模糊、
  黑白 / 复古 / 反相、**暗角**、动态**胶片颗粒**
- 混合模式（screen、multiply、overlay……）、适配模式（contain / cover / stretch）、
  四边独立裁切、圆角、水平 / 垂直翻转
- **绿幕抠像**，带容差 / 边缘柔化与溢色抑制
- **AI 背景移除**（人像抠图，通过 MediaPipe 在浏览器内完成）

**动态**

- 约 25 个属性支持关键帧动画，可设置缓动
- **片段上的关键帧标记**——片段主体上每个关键帧时间点都有一个菱形标记
  （悬停提示会列出通道；多个通道共用同一时间点时显示数量角标）。
  <kbd>Ctrl/Cmd+←</kbd> / <kbd>Ctrl/Cmd+→</kbd> 把播放头跳到上一个 / 下一个关键帧
  （优先考虑所选片段，否则用播放头下方的片段）
- **关键帧曲线图**——在检查器里切换某个属性的曲线，节目监视器旁会显示插值后的数值图；
  点击图表可跳转到对应时间
- **速度斜坡**——给 `speed` 打关键帧，引擎会对视频**以及**导出的音频混音做时间重映射
  （就是那个「快切入慢动作」的 reel 招式）
- **摄像机抖动**和 **RGB 分离 / 色差**，两者都可做动画
- 17 种转场：淡入淡出、滑动、擦除（4 个方向）、缩放、圆形开幕、旋转、模糊、
  甩镜、**故障（glitch）**、**弹出（pop）**

**文字**

- **标题样式**——一键套用成套外观（Impact、Elegant、Kinetic cut、Neon、
  Handwritten、Luxury 等）；新建标题会自动变换字体、位置和动画，
  而不是永远落在同一种寡淡的默认样式上
- 动态字幕：typewriter、word-pop、word-slide、karaoke、**letter-pop**、
  **wave**、**bounce**、**shake**、**clip-reveal**、**zoom-in**、
  **font-cut**（随节奏切换字体）、**rise-mask**
- **霓虹辉光**，做出那种 TikTok 字幕的感觉
- 字体编辑：系统字体、放进 `library/fonts/` 的自定义字体，以及
  **任意 Google Font（写名字即可）**——会自动加载
- 渐变填充、描边、背景胶囊、字间距、行高、字重、斜体、全大写、柔和阴影
- **文本排版**——水平对齐：左 / 居中 / 右 / **两端对齐**（在词之间补空格）。
  拖动标题的四角手柄可创建**文本框**（`boxW` / `boxH`）；继续拖角可调整大小
  （对角保持固定；<kbd>Ctrl/Cmd</kbd> 从中心缩放；<kbd>Shift</kbd> 锁定比例）。
  在文本框内，文字默认按固定字号换行；打开 **Scale to fit** 则会缩小字号，
  让整段文字刚好放得下。**垂直对齐**（上 / 中 / 下）决定文字块在框内的纵向位置。
  把 Box W/H 设为 `0` 即可回到「贴合内容」的尺寸。

**动画 SVG 片段**

- `svg` 是一等公民片段类型：用 CSS `@keyframes` 做动画的 SVG，在预览和导出中都能
  **逐帧精确**渲染（合成器可以把动画冻结在任意时刻）。agent 也可以自己写矢量叠加层
  ——下三分之一字幕条、彩纸、闪光等——就是普通的 `.svg` 文件。仓库里附带了起始模板。

**复刻参考视频**

- 给它一个参考成片（你喜欢的某条 reel），它会返回一份**剪辑蓝图**：
  分镜边界、音乐节拍与 BPM、响度曲线、每个镜头的能量值、drop 点，
  外加把参考视频的**音轨提取**进你的媒体库，随时可以用自己的素材重建同一个创意。
  没有额外依赖（解码交给 ffmpeg，起始点 / 速度检测是纯 Node 实现）。
  可用 `node analyze.js ref.mp4`、`POST /api/analyze`，或 MCP 工具
  `fablecut_analyze_reference`。

**素材库**

- `library/` 下的文件夹会作为标签页出现在界面里：**Elements**（叠加素材）、
  **Sound FX**、**SVG**——把文件丢进去，打开着的编辑器会实时刷新

**导出**

- agent 也能导出：`fablecut_export` 会在已打开的编辑器或无界面的 Chrome / Edge
  中执行快速导出，并返回文件路径
- 快速导出：浏览器渲染每一帧并生成离线音频混音，由 ffmpeg 编码成逐帧精确的
  CRF-18 MP4（切换标签页也会继续渲染）
- 没有 ffmpeg 时，退回到基于 MediaRecorder 的实时导出

## 快速开始

```bash
git clone https://github.com/ronak-create/FableCut.git
cd FableCut
node server.js        # → http://localhost:7777
```

环境要求：**Node 18+** 和 Chromium 内核的浏览器。**PATH 中的 ffmpeg** 是可选的，
但推荐安装（用于快速导出和上传时的 remux）。AI 背景移除会在首次使用时从 CDN 拉取模型。

服务器**只监听 127.0.0.1**（v1.3.1 起）。要在局域网内的其他设备上访问，需要显式开启：
`HOST=0.0.0.0 FABLECUT_ALLOWED_HOSTS=<你的IP> node server.js`。

把素材拖进窗口（或放进 `./media/`），把片段拖到时间线上，编辑，导出。

## 用 AI agent 驱动

agent 需要的一切都在 **[CLAUDE.md](../../CLAUDE.md)** 里——完整的 schema、语义和配方。
把任意有能力的模型指向那个文件，它就能端到端地操作编辑器。

> 📖 **可浏览的文档：** 同一份手册的网页版，每个主题一页（MCP 工具、`project.json`
> schema、片段属性、配方、REST API、导出）：**[fablecut.space/docs](https://fablecut.space/docs/)**。

三种等价的控制方式：

1. **MCP**（Claude Code / Claude Desktop 的首选）——把内置的零依赖 MCP 服务器
   注册一次：

   ```bash
   claude mcp add -s user fablecut -- node "<路径>/fablecut/mcp-server.js"
   ```

   工具：`fablecut_status`（自动启动编辑器）、`fablecut_docs`、
   `fablecut_get_project`、`fablecut_set_project`、`fablecut_patch_project`、
   `fablecut_import_media`、`fablecut_analyze_reference`、
   `fablecut_encode_profiles`、`fablecut_normalize_audio`、`fablecut_auto_duck`、
   `fablecut_denoise`、`fablecut_export`。

   FableCut 也已发布到**官方 MCP registry**，标识为
   [`io.github.ronak-create/fablecut`](https://registry.modelcontextprotocol.io/v0/servers?search=fablecut)
   ——每个 release 都附带一个 MCPB 包（`fablecut.mcpb`），支持 MCPB 的客户端可直接安装。

   这套接口在设计上就**节省 token**：agent 用小粒度的 op 修改时间线
   （`fablecut_patch_project`）而不是把整个文档来回传输，读取时可以拿
   一行一个片段的紧凑摘要（`fablecut_get_project {compact:true}`），
   查文档时只取需要的章节（`fablecut_docs {section:"props"}`）。
2. **直接改文件**——读 `project.json`，修改，把 `revision` 加一，写回。界面会自动重载。
3. **REST**——`GET/PUT /api/project`、`POST /api/upload`、`GET /api/library`，
   以及 `/api/events` 上的 SSE。完整列表见 CLAUDE.md。

例如，对 Claude Code 说：*「把这六段素材按节拍标记切开，加一个 teal-orange 调色，
上面放 word-pop 字幕，每个剪切点加一个 whoosh 音效」*——然后看着时间线自己重建。

或者直接丢给它一个参考视频：*「这条 reel 我喜欢，分析一下，用我的素材照着重做，
音乐不变」*。agent 会调用 `fablecut_analyze_reference` 拿到剪辑蓝图
（分镜、节拍、BPM、能量、drop 点、抽取出来的音乐），然后用你的素材逐镜头重建结构。

**并发编辑不会互相覆盖**：界面、MCP 工具和直接写 `project.json` 三方都遵守同一个
`revision` 计数器。如果 agent 正在工作时你在界面里改了片段，
agent 的下一次写入会被拒绝（REST API 返回 409 / `fablecut_set_project` 报冲突错误），
而不是悄悄覆盖你的改动。反过来，当 agent 的写入盖过了你尚未保存的本地调整时，
界面同样会检测到并弹提示告诉你，而不是默默丢弃。

## 项目结构

```
server.js        零依赖 HTTP 服务器：静态托管、REST API、SSE、ffmpeg 导出流水线
app.js           编辑器本体：时间线 UI、合成器、关键帧、文字引擎、
                 SVG 光栅化、绿幕抠像、导出器
index.html       单页界面
style.css        深色编辑器主题
mcp-server.js    stdio MCP 服务器，把编辑器暴露给 AI agent
analyze.js       参考视频分析器：分镜、节拍 / BPM、能量、drop、
                 音乐提取（既是模块也是 CLI）
CLAUDE.md        agent 手册（schema + 配方）——也由 fablecut_docs 提供
project.json     你的时间线（首次运行时创建；已 gitignore）
media/           项目素材（已 gitignore）
analysis/        /api/analyze 缓存的剪辑蓝图（已 gitignore）
library/         默认素材：elements/ sfx/ svg/ fonts/
exports/         成品渲染（已 gitignore）
```

## 编写动画 SVG 叠加层

SVG 用普通的 CSS `@keyframes` 做动画。只有一条约定：**绝不要写死 `animation-delay`**
——改为设置 `--d: 0.4s`，合成器会暂停所有动画并重新计算延迟来驱动时间。
完整规则和骨架模板见
[CLAUDE.md](../../CLAUDE.md#authoring-animated-svgs-the-svg-clip-kind)，
可用的示例在 [`library/svg/`](../../library/svg/)。

## 说明

- 仓库自带 **20 款 Google Fonts**（`library/fonts/`，OFL 许可——见其中的 `LICENSES.md`），
  以及一批自制的 SVG 叠加层和动画元素（`library/elements/`、`library/svg/`，
  与仓库其余部分一样为 MIT）。
- `library/sfx/` 留给你自己填充（已 gitignore）：音效网站通常不允许把它们的文件
  再分发到公开仓库，所以 FableCut 没有内置——`library/sfx/README.md` 列出了
  一些不错的免费来源。
- 导出在浏览器里进行，因为合成器*本身就是*浏览器；agent 会请你点「导出」按钮
  （或者直接用 ffmpeg 从 `media/` 渲染）。

## 社区

有问题、想法，想展示你的作品，或者想参与决定接下来做什么？欢迎加入
**[FableCut Discord](https://discord.gg/EFMQH7d6Tv)**。Bug 和功能需求仍然建议提到
[GitHub issues](https://github.com/ronak-create/FableCut/issues)。

## 许可证

[MIT](../../LICENSE)

---

<sub>本翻译与 <a href="../../README.md">README.md</a> 的 <code>3dd1d55</code>
版本同步。如有出入以英文 README 为准；发现内容过时欢迎提 issue 或 PR。</sub>

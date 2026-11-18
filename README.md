# Beautify

Make Obsidian's file explorer work like Notion: folders as pages, drag-and-drop manual ordering, colorful icons, hide rules, per-note view modes, and a full inline task system (Dashboard / Kanban / Eisenhower matrix). Free and open source under the MIT license. Formerly known as Branch & Order; existing data migrates automatically.

## Installation

- **Manual**: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/jiangyugang/obsidian-beautify/releases/latest) into `<vault>/.obsidian/plugins/beautify/`, restart Obsidian, and enable **Beautify** under Settings → Community plugins.
- **BRAT**: install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then add the repository `jiangyugang/obsidian-beautify` as a beta plugin.

## Usage

- **Pages**: click a folder to open its index note (`Folder/Folder.md`); hover the ＋ button next to any name to create sub-notes; drag items to reorder. Hover any folder segment of the breadcrumb at the top of a note to list that folder's child notes and jump to one.
- **Tasks**: type `[]` followed by a space in the editor to create a task instantly; run the command **Open task view** for the Dashboard / Kanban / Quadrant views. The bookkeeping date fields (➕ created ✅ done ❌ cancelled 🛫 start ⏳ scheduled) are hidden from notes by default — due dates and priority stay visible, and Settings → Tasks → **Show task date fields** displays everything.
- **Icons & hide rules**: right-click any file or folder to set an icon or hide it; use the eye button at the top of the file explorer to reveal hidden items.
- **View modes**: toggle reading/editing with the button in the editor's top-right corner (or Ctrl/Cmd+E) — Beautify remembers the choice per note.

完整中文文档见下。

让 Obsidian 的文件列表像 Notion 一样工作:目录即页面、手动排序、彩色图标、隐藏规则、按笔记属性自动切换视图,并内置一套行内任务管理(工作台 / 看板 / 四象限)。前身是 Branch & Order(合并 Branch Note 与 Explorer Order Editor),旧数据自动升级迁移。

## 安装

**手动**:下载本仓库的 `main.js`、`manifest.json`、`styles.css` 三个文件,放入 `<库>/.obsidian/plugins/beautify/`,重启 Obsidian 后在 设置 → 第三方插件 中启用。

**BRAT**:安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) → 设置 → Add Beta Plugin → 输入 `jiangyugang/obsidian-beautify`(需仓库已发布 Release)。

## 功能

### 页面

- **目录即页面**:点击文件夹打开同名首页笔记(`目录/目录.md`);无首页时显示「开始书写」引导页,空首页按退格/删除即删除首页(进回收站、可撤销)
- **行内 ＋**:鼠标移到任意文件夹/笔记名称右侧出现 ＋ 号,点击即新建子文档(与右键「新建子笔记」一致,支持晋升与撤销)
- **双击展开/收起子项**(默认开启,设置 → 交互):双击有子文档的文档展开其子文档列表,再次双击收起;单击仅打开笔记,折叠箭头保持原生行为
- **右键菜单**:新建子笔记、删除首页、设置图标、排序方式
- **面包屑悬停显示子文档**(设置 → 页面与子笔记):悬停文档顶部面包屑的任意目录段弹出该目录的子文档列表,遵循文件列表的排序与隐藏规则;点击打开(目录开首页笔记,Ctrl/⌘ 新标签页);点击面包屑本身仍是原生行为(在系统文件管理器中显示)
- 重命名目录自动同步首页名;文件/目录的重命名与删除自动跟随;支持撤销上次页面操作、未保存草稿恢复

### 排序

- **手动排序**:拖拽换序、右键「设置排序」弹窗、Alt+方向键、上移/下移/置顶/置底命令
- 每个文件夹可单独设置排序模式:手动 / 名称 / 最近修改 / 创建时间
- 排序数据保存在 `Beautify.md` 配置笔记内,不生成任何额外排序文件

### 增强与外观

- **` ```bn-children ` 子页面列表块**:首页内自动渲染子页面(按保存顺序,支持排序模式),带「＋ 新建子页面」按钮,文件变化自动刷新
- **子笔记模板**:`{{title}}` / `{{date}}` / `{{time}}` 占位符;文件夹子项计数徽章
- **彩色图标**:右键任意文件/文件夹 → 设置图标,弹出选择面板(约 500 个彩色 emoji + 约 360 个线条图标,支持中文关键词搜索、随机选择、移除);新笔记默认自动分配随机 emoji(设置中可关);图标同时显示在 bn-children 列表中
- **隐藏规则**(设置中每行一条):不含 `/` 的按名称隐藏同名文件夹,含 `/` 的按路径隐藏该项及子内容;左上角眼睛按钮临时显示被隐藏文件;右键「取消隐藏此项」移除命中规则
- **按笔记切换视图**:笔记属性 `auto-view-mode`(键名可自定义)指定打开时的视图——`reading` = 阅读视图、`edit` = 实时预览、`source` = 源码模式;点编辑器右上角切换(或 Ctrl+E)即切换并记忆该笔记,切回库默认视图自动清除记忆
- **文档收藏 / 最近打开**:各自独立开关(设置 → 交互),收藏区与最近打开区显示在文件列表顶部(收藏过的不再重复显示)
- 设置界面完整跟随 Obsidian 语言设置(含中文翻译)

### 任务管理

- **一切元数据行内化**:任务就是普通 Markdown,元数据以表情字段写在行尾,随库同步、任何编辑器可见——`➕ 创建 ✅ 完成 ❌ 取消 🛫 开始 ⏳ 计划 📅 截止 🔺⏫🔼🔽⏬ 优先级`,字段顺序不限
- **日期字段默认隐藏**(设置 → 任务 →「任务行显示日期字段」,默认关闭):笔记中的任务行默认只显示正文、`📅 截止`与优先级,五个时间戳(`➕ 创建 ✅ 完成 ❌ 取消 🛫 开始 ⏳ 计划`)在阅读视图与实时预览/源码中隐藏;实时预览/源码中光标移到所在行即显示完整内容,数据仍完整保存在行内,编辑弹窗不受影响;打开开关后各处按原样显示。任务视图卡片上的 ➕/✅/❌ 标签同样跟随该开关
- `[] + 空格` 快速建任务并自动盖 `➕ 今日` 戳;勾选自动盖/撤 `✅ 日期`(阅读视图的复选框也能直接勾选回写)
- **图标 = 描述行首的表情**:纯文本,实时/源码/阅读视图、其他设备全部可见
- **编辑弹窗**:描述、状态、图标、四个日期、优先级,保存只重写那一行;命令「编辑光标处任务」或悬停工具条进入
- 悬停任务行出现工具条:[设图标] [编辑] [转子页面];转子页面保留全部行内字段,`[[内链]]` 与 `[名称](路径.md)` 两种格式都识别
- **任务视图**:命令「打开任务视图」首次自动创建 `任务视图.md`,内含一个代码块渲染三个视图,阅读与实时预览通用、任务变动自动刷新:
  - **工作台**:统计卡片(待办/今日到期/已逾期/重要/今日完成/本周完成)、今日聚焦(逾期 + 今日到期)、优先级分布、最近完成
  - **看板**:待办/已完成/已取消三列,卡片拖拽换列自动盖 ✅/❌ 戳,点卡片打开编辑弹窗
  - **四象限**:按「重要 × 紧急」自动分象限,卡片可拖拽换象限并自动补齐/清空/推后对应字段

## 从旧版本升级

首次启用时自动迁移,无需手动操作:

- 来自 **Branch & Order / Beautify 旧版**:整套设置原样导入;旧排序文件(`explorer-order.md`、v1.x 的 indexBackup 备份)启动时自动转换,旧笔记移入回收站
- 来自 **Branch Note + Explorer Order Editor**(从未用过合并版时):分别导入各自 data.json 与排序笔记
- **1.3.0 起 `Beautify.md` 的 orderEditor 槽改为文档树格式**:`index` 由「文件夹路径 → 名称数组」的扁平表变为按目录层级嵌套的树,条目图标(原 host 槽的 `icons` 扁平表)也内联到各节点上——`{ "工作空间": { "icon": "🏢", "order": true, "children": […] } }`;`order: true` 表示该目录的 children 顺序是保存的手动排序。旧格式(含 1.3.0 之前的扁平 icons)首次启动自动转换,数据不丢

> 注意:命令前缀从 `branch-order:` 变为 `beautify:`,如绑定过快捷键需重新绑定。

## 技术说明

全部为可读的原生代码,不内嵌任何压缩产物:排序核心与页面核心均为原生重写,行为对齐两个原插件;任务模型参考 [obsidian-tasks](https://github.com/obsidian-tasks-group/obsidian-tasks)。所有数据分槽存储于 `Beautify.md` 配置笔记——其中 orderEditor 槽(v1.3.0 起)是与库结构同形的文档树:层级嵌套的 `children` 即目录结构,节点可带 `icon`(条目图标),带 `order: true` 的目录其 children 顺序即保存的手动排序。启动带自诊断:健康时静默,异常时才弹窗提醒。

## 许可

MIT,完整文本见 [LICENSE](LICENSE)。排序与页面核心的行为基准来自 [elfmedy/branch-note](https://github.com/elfmedy/branch-note) 与 [vcarus/obsidian-explorer-order-editor](https://github.com/vcarus/obsidian-explorer-order-editor)(均 MIT);两位原作者未参与或背书本插件。

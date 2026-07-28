# Pony XL 与 FLUX.1-dev GGUF 生图风格对比

## 结论

- **Pony XL** 更擅长二次元人物、动漫插画、角色立绘、兽人或拟人角色，以及夸张的姿势和视角。
- **FLUX.1-dev GGUF** 更擅长写实摄影、商业视觉、复杂场景，以及准确理解自然语言描述。

| 对比项 | Pony XL | FLUX.1-dev GGUF |
| --- | --- | --- |
| 核心优势 | 角色表现与动漫风格 | 写实度与提示词理解 |
| 擅长题材 | 动漫人物、游戏角色、兽人、卡通、半写实角色 | 人像摄影、产品、建筑、室内、风景、电影概念图 |
| 人物姿势 | 对夸张姿势、服装和角色属性比较敏感 | 自然动作、多人关系及场景互动更稳 |
| 画面风格 | 日系动漫、厚涂、赛璐璐、同人插画 | 摄影、电影感、商业广告、写实数字艺术 |
| 提示词习惯 | 更适合标签式提示词 | 更适合完整的自然语言描述 |
| 文字生成 | 通常较弱 | 英文招牌、海报短文字相对更强 |
| 场景构图 | 单人或双人角色图较强，复杂环境一般 | 复杂空间、物体关系、镜头语言更好 |
| 速度与资源 | 通常更快、更容易运行 | 通常更慢，内存与显存压力更大 |

本地 ComfyUI 工作流对应：

| 模型 | Workflow 文件 |
| --- | --- |
| Pony XL | `pony_xl_12gb.json` |
| FLUX.1-dev GGUF | `flux_dev_gguf_12gb.json` |

## Pony XL 擅长的题材与风格

Pony XL 通常指 Pony Diffusion V6 XL 或其衍生模型，主要强项包括：

- 二次元角色立绘、头像和壁纸
- 动漫、漫画、赛璐璐、厚涂及半写实插画
- 游戏角色、同人角色和具有明确服装属性的角色
- 兽人、拟人动物及奇幻种族
- 夸张动作、特殊视角和人物姿态
- 使用 LoRA 定制角色、画风及服装

Pony 系模型通常更适合使用标签式提示词：

```text
score_9, score_8_up, source_anime,
1girl, silver hair, blue eyes,
fantasy armor, dynamic pose,
dramatic lighting, detailed background
```

原始 Pony 系模型还经常使用 `source_anime`、`source_cartoon`、`source_furry` 等来源标签，以及 `score_9` 一类质量标签。

### Pony XL 的相对短板

- 原生照片级写实能力通常不如 FLUX
- 建筑、产品和复杂空间容易带有插画感
- 招牌、包装等画面内文字容易出现乱码
- 普通自然语言长句未必比标签式提示词有效

需要注意，`pony_xl_12gb` 如果是某个 Pony 衍生或合并模型，可能被专门调整为写实、3D、国风等方向，其实际表现应以具体 checkpoint 的模型说明和示例图为准。

## FLUX.1-dev GGUF 擅长的题材与风格

FLUX.1-dev 是一个 120 亿参数的通用文生图模型，主要优势是画质和提示词遵循能力，尤其适合：

- 写实人像、时尚摄影和街拍
- 产品广告、电商主图、汽车及静物
- 建筑、室内设计、城市与自然景观
- 电影剧照、概念设计和氛围光影
- 多人物、多物体及复杂空间关系
- 海报、封面及带有少量英文文字的画面
- 使用长句精确描述镜头、材质、位置和动作

FLUX 更适合使用完整的自然语言提示词：

```text
A cinematic portrait of a young woman standing inside a
rainy neon-lit train station, wearing a dark green coat,
shot on a 50mm lens, shallow depth of field, realistic skin,
soft reflections on the floor
```

FLUX 也可以生成动漫图，但基础模型的动漫风格往往比较泛化，特定角色和特定画风未必像 Pony 那样稳定。搭配适合的 FLUX 动漫 LoRA 后，动漫表现会有明显提升。

## GGUF 和“12GB”的含义

GGUF 主要是一种量化格式，并不代表一种新的画风。常见的 FLUX.1-dev GGUF 是从原始 FLUX.1-dev 直接量化转换而来，并非重新训练的风格模型，因此整体能力和审美仍然属于 FLUX。

接近 12GB 的版本通常可能是 `Q8_0`，模型文件约为 12.7GB；相比约 23.8GB 的 F16 权重更加节省内存，通常只有很小的画质损失。

模型文件大小并不等于实际峰值显存占用。文本编码器、VAE、运行缓存、出图分辨率和批次大小也会占用内存或显存，因此 12GB 显卡运行时仍可能需要使用分层加载或内存卸载。

## NovaStory 内置画风与模型推荐

基于 `docs/风格参考/1/pixiv-favor.txt` 画师收藏（太极八荒、好就是大、星海一条鱼、五岳、XXAO、Kurumi Tokisaki、wind 等）提炼的视觉技法，与前端 `VISUAL_STYLES` 对齐。提示词侧重**光影 / 笔触 / 材质 / 氛围**，尽量与具体物体解耦。

### 标准风格（默认展示）

| value | 名称 | 推荐模型 | 画风要点 | 参考倾向 |
| --- | --- | --- | --- | --- |
| `anime` | 日系动漫 | **Pony XL** | 赛璐璐、干净线稿、鲜艳配色 | 通用日系插画 |
| `ancient_fantasy` | 古风幻想 | **Pony XL** | 国风仙侠、半写实渲染、体积光 | 太极八荒：国漫 / 古风美人 |
| `xianxia_immortal` | 仙侠清冷 | **Pony XL** | 清冷玉色、薄纱透光、仙气氛围 | 好就是大：清冷仙子 / 修仙 |
| `guoman_painterly` | 国漫厚涂 | **Pony XL** | 厚涂笔触、强轮廓光、国漫完成度 | 太极八荒类国漫厚涂 |
| `ethereal_glow` | 光晕仙气 | **Pony XL** | bloom、逆光颗粒、柔光肖像 | 星海一条鱼：pixivGlow 仙气 |
| `aesthetic_romance` | 唯美氛围 | **Pony XL / FLUX** | 诗意色调、浅景深、精致肖像 | 五岳：唯美 / 国风氛围 |
| `game_illustration` | 游戏立绘 | **Pony XL** | 商业 splash art、清晰剪影、材质对比 | 原神 / 崩铁类角色立绘 |
| `chibi` | 可爱/Q版 | **Pony XL** | 大头小身、柔和色块 | 萌系 Q 版 |
| `semi_realistic` | 半写实 | **Pony XL / FLUX** | 厚涂融合、SSS、电影光 | 通用半写实 |
| `cyberpunk` | 赛博朋克 | **Pony XL / FLUX** | 霓虹、湿反射、高对比 | 未来都市氛围 |
| `ink_wash` | 水墨/墨绘 | **FLUX.1-dev GGUF** | 笔触、留白、宣纸质感 | 传统水墨意境 |
| `surreal` | 超现实/梦幻 | **FLUX.1-dev GGUF** | 不可能几何、柔焦、象征构图 | 梦幻概念图 |
| `ai_generated` | AI 抛光感 | **FLUX.1-dev GGUF** | 极致细节、体积光、完美构图 | 通用 AI 商业感 |
| `sketch` | 手绘/草图 | **Pony XL** | 铅笔线、剖面线、纸纹 | 速写 / 概念线稿 |
| `mecha` | 机甲 | **Pony XL / FLUX** | 硬表面、金属、轮廓光 | 机甲概念 |
| `cinematic_photo` | 电影写实 | **FLUX.1-dev GGUF** | 真实皮肤、镜头景深、胶片调色 | 电影剧照 / 实拍感 |

### 高级风格（偏成人，默认隐藏）

偏成人向风格归类为 **advanced**，默认不在导演模式 / 项目设置中展示。需在**系统设置**隐藏区域连续点击 5 次开启。定义存放在本地文件：

- 本地文件（不入 git）：`frontend/local/advanced_visual_styles.ts`
- 模板（可提交）：`frontend/local/advanced_visual_styles.example.ts`

| value | 名称 | 推荐模型 | 画风要点 | 参考倾向 |
| --- | --- | --- | --- | --- |
| `elegant_mature` | 御姐半写实 | **Pony XL** | 成熟比例、精致半写实面容、电影主光 | XXAO / 好就是大：御姐 / 熟女气质肖像 |
| `sensual_gufeng` | 魅惑古风 | **Pony XL** | 国风薄纱光影、暧昧轮廓光、华丽服饰质感 | 太极八荒 / 好就是大：古风魅惑 |
| `alluring_portrait` | 魅惑肖像 | **Pony XL** | 近景肖像、皮肤高光、柔焦背景、高级时装感 | 收藏向角色美型 / 魅惑构图 |

> 高级风格仍遵循「技法解耦」原则：描述渲染与光影，不把具体 NSFW 物体写进默认 style prompt。

### 模型选择速查

- **优先 Pony XL**：日系动漫、古风/仙侠角色、国漫厚涂、游戏立绘、Q 版、角色姿势与服装属性强的镜头
- **优先 FLUX.1-dev GGUF**：电影写实、复杂场景空间、产品/建筑、长自然语言描述、水墨意境与超现实构图
- **两者皆可**：唯美氛围、半写实、赛博朋克、机甲（角色偏 Pony，场景偏 FLUX）
- **半写实美女 / 游戏角色**：优质 Pony 衍生通常更省资源，风格更稳
- **动漫 + 复杂构图**：可考虑 FLUX + 动漫 LoRA

## FLUX.1-dev 人像东亚化（东方/亚洲面孔）优化策略

针对使用 `flux_dev_gguf_12gb.json` 时人物容易偏欧美白人面孔的问题，NovaStory 已在系统层面同时内置了**方案一与方案二**：

1. **方案一（提示词层东亚特征显式强化 - 默认生效）**
   - 前端 `VISUAL_STYLES` 与后端生成引擎会在使用 FLUX 时，自动注入 `East Asian facial features, soft facial contour, East Asian beauty` 等面部特征修饰词，并在负向提示词中剔除 `western face, caucasian`。
2. **方案二（ComfyUI 工作流 LoRA 动态挂载 - 可选进阶）**
   - 在 ComfyUI 的 `models/loras/` 目录下放入一个专为 FLUX 训练的东亚人像或国风 LoRA（如 Civitai 上的 Asian Girl/Guofeng LoRA），NovaStory 后端服务将自动动态识别并插拔 `LoraLoader` 节点（权重 0.8），无需手动改写 JSON 文件，彻底解决面孔问题。

## 选择建议

- 动漫角色、同人立绘、兽人和强姿势控制：优先选择 **Pony XL**
- 真人、商品、建筑、复杂场景和长提示词：优先选择 **FLUX.1-dev GGUF**
- 东方/国风写实美型人像：**FLUX.1-dev GGUF + 东亚 Prompt Booster / 亚洲人像 LoRA**
- 半写实美女或游戏角色：优质的 Pony 衍生模型通常更省资源，也更容易调出明确风格

## 参考资料

- [FLUX.1-dev 官方模型卡](https://huggingface.co/black-forest-labs/FLUX.1-dev)
- [FLUX.1-dev GGUF 模型卡](https://huggingface.co/city96/FLUX.1-dev-gguf)
- [Pony Diffusion V6 XL 文件与提示词示例](https://huggingface.co/LyliaEngine/Pony_Diffusion_V6_XL/blob/main/ponyDiffusionV6XL_v6StartWithThisOne.safetensors)
- 风格参考：`docs/风格参考/1/pixiv-favor.txt`、`docs/风格参考/1/古风幻想.txt`
- 前端常量：`frontend/constants.ts`、`frontend/local/advanced_visual_styles.ts`（本地）


---

**Pony XL 与 FLUX.1-dev GGUF 推荐专用 LoRA**（2026 年主流选择，基于 Civitai 下载量、社区反馈与实际兼容性）：

### 一、Pony XL（Pony Diffusion V6 XL）推荐 LoRA
Pony 生态最成熟，角色/画风/细节类 LoRA 极多。优先下载这些通用强力款（放入 `models/loras/`）：

| 类型 | 推荐 LoRA | 建议权重 | 说明 |
|------|-----------|----------|------|
| **细节增强** | **Pony Detail Tweaker** | 0.6–1.0 | 最经典细节滑块，增加线条与阴影复杂度，几乎不破坏构图 |
| **细节增强** | Detail Slider LoRA (PonyXL/SDXL) | 0.4–0.8 | 可控细节强度，适合叠加 |
| **细节/写实** | Vixon's Pony Styles — Detailed | 0.6–0.8 | 强力提升真实感与细节，效果明显 |
| **画风** | Incase Style [PonyXL] | 0.6–1.0（单独）或 0.4–0.6（叠加） | 最常用 Western/漫画风 NSFW 风格，几乎无触发词 |
| **画风** | ExpressiveH (Hentai Style) | 0.4–0.6 | 经典 Hentai 风格参考，触发词 `Expressiveh` |
| **画风** | CicaStyle [PonyXL] | 0.7–1.0 | 多风格通用（含光泽皮肤、服装细节），兼容性好 |
| **质量提升** | Best of Pony | 0.7–1.0 | 基于高分图训练的“美化”LoRA，增加视觉冲击力 |
| **通用细节** | Add More Details / Pony Add More Details | 0.3–0.5 | 轻量细节补充，适合堆叠底层 |

**使用建议**：
- 总权重尽量控制在 1.5 以内。
- Pony 推荐 Clip Skip 2。
- 正面提示词习惯加 `score_9, score_8_up, score_7_up` 等质量标签。

### 二、FLUX.1-dev（含 GGUF）推荐 LoRA
FLUX 的 LoRA 相对较少，但核心需求已很清晰。**GGUF 版本支持 LoRA**（通过 ComfyUI-GGUF 的 Unet Loader + 普通 LoRA Loader，实验性但社区已广泛使用）。

| 类型 | 推荐 LoRA | 建议权重 | 说明 |
|------|-----------|----------|------|
| **NSFW 解锁（必下）** | **aidmaNSFWunlock** | 0.5–1.0（常用 0.7–0.8） | 目前下载量最高、最稳定的 FLUX NSFW 解锁 LoRA（约 19MB），触发词 `aidmaNSFWunlock` |
| **写实风格** | XLabs Flux Realism | 0.6–1.0 | 经典写实向，提升皮肤与整体真实感 |
| **风格/质量** | Best of Flux | 0.7–0.9 | 类似 Best of Pony，基于高分图训练的增强 LoRA |
| **细节** | Detail Enhancer FLUX | 0.5–1.0 | 纹理与细节补充 |
| **解剖/裸体** | Nude Style for FLUX V2 | 0.8–1.0 | 改善身体细节与 nudity 表现，常与 aidma 叠加 |
| **解剖补充** | X Plus V2 或其他 Anatomy 类 | 0.5–0.8 | 进一步修正姿势与身体结构 |

**使用建议**：
- 基础组合：`aidmaNSFWunlock`（0.7–0.8）+ 一个风格/细节 LoRA。
- 权重过高容易过拟合或产生伪影，建议从 0.6 开始测试。
- GGUF 量化越低（如 Q4），LoRA 效果可能略弱，优先用 Q5_K_S / Q6_K / Q8_0。
- 官方原版 FLUX.1-dev 对 NSFW 有较强限制，aidma 几乎是标配。

### 下载与放置
- 主要来源：**Civitai**（搜索对应名称即可）。
- 文件放到本地 ComfyUI 的 `models/loras/` 目录。
- 在高级设置或工作流中填写完整文件名（如 `aidmaNSFWunlock.safetensors`），并设置权重。

**快速入门推荐组合**：
- **Pony XL**：Pony Detail Tweaker + Incase Style / ExpressiveH
- **FLUX GGUF**：aidmaNSFWunlock + XLabs Flux Realism 或 Best of Flux

需要特定角色、姿势或更细分风格（如 furry、特定画师）的话，告诉我方向，我可以再精准推荐。

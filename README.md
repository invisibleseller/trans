# 实时同传 / Realtime Interpreter

一个极简的浏览器端实时同传网页应用。麦克风音频直连 OpenAI Realtime API，左侧显示源语言识别，右侧实时显示译文。

## 支持的语言

源语言与目标语言均可选择：

- 中文 (zh)
- English (en)
- 日本語 (ja)
- Deutsch (de)
- Русский (ru)
- Français (fr)

任意两种之间互译，可一键互换。

## 使用

1. 在任意静态服务器上托管这三个文件，或直接本地起一个：

   ```bash
   python3 -m http.server 8080
   # 访问 http://localhost:8080
   ```

   注意：必须通过 `http://localhost` 或 `https://` 访问，浏览器不会在 `file://` 下授权麦克风。

2. 打开页面 → 点击 **设置** → 填入 OpenAI API Key（仅保存在本机 localStorage）。

3. 选择源语言 / 目标语言。

4. 点击 **开始**，授权麦克风。开始说话即可。

## 实现要点

- `app.js` 通过 WebRTC 直连 `api.openai.com/v1/realtime`。
- 用 `input_audio_transcription`（whisper-1）拿源语言识别文本。
- 用 `instructions` 把模型固定为"专业同传译员，只输出译文"。
- 切换语言时如果会话还在，会自动 `session.update` 热更新指令与识别语言。

## 安全提醒

API Key 直接从浏览器发往 OpenAI，任何能打开此页面的人都可能读取它。
仅在受控环境下使用，或为该 key 设置严格的使用上限。

# 实时同传对话（Cloudflare 部署版 · 试用）

1 对 1 实时同传字幕：A 创建房间、B 用房间号 + 密码加入。两人各说各的语言，对方实时看到 **自己语言** 的字幕。试用版每人 30 秒语音输入。

## 关键设计：免 VPN

浏览器只与你的 Cloudflare Worker 通信，**不直连 OpenAI**：

```
[Browser]  ── WebSocket ──>  [Cloudflare Worker (Durable Object)]
                                        │
                                        └── WebSocket ──> api.openai.com
                                              (Authorization: 你的 key)
```

- 浏览器把麦克风音频用 AudioWorklet 编成 PCM16 @ 24 kHz，base64 后通过 WS 发到 Worker。
- Worker 在 Durable Object 内反向代理 OpenAI Realtime WebSocket，附加 `Authorization`。
- 上下行事件（包含译文文本）原样在两个 WS 之间互转。
- 房间字幕在两个 peer 之间通过另一条 WS 转发。

因此从中国大陆使用时，只要能访问你的 Cloudflare 域名即可，**不需要 VPN**。建议绑定自定义域名以获得更稳定的连通性。

## 试用配额

服务端按音频字节数计：30 秒 × 24000 Hz × 2 bytes = 1,440,000 bytes 每人。超过即由 Worker 关闭代理 WS 并通知客户端。

调整：修改 `wrangler.toml` 中的 `TRIAL_SECONDS` 后重新 `wrangler deploy`。

## 部署到 Cloudflare

```bash
npm install
npx wrangler login

# 把你的 OpenAI key 作为 secret 上传（用户看不到，浏览器也拿不到）
npx wrangler secret put OPENAI_API_KEY

# 部署
npm run deploy
```

部署后会得到 `https://realtime-interp.<your-subdomain>.workers.dev`。

### 绑定自定义域名（推荐）

在 Cloudflare Dashboard → Workers → 你的 Worker → Triggers → Custom Domains，加一个自有域名（如 `talk.yourdomain.com`）。这样：

- 国内用户访问更稳定；
- 看上去也更正式。

## 本地开发

```bash
npm install
npm run dev
# http://localhost:8787
```

注意：本地 `wrangler dev` 模式下，麦克风需要 HTTPS 或 localhost。OpenAI 调用需要设置 `OPENAI_API_KEY`：

```bash
# .dev.vars
OPENAI_API_KEY=sk-...
```

## 支持的语言

中文、English、日本語、Deutsch、Русский、Français。任意源 ↔ 任意目标。

## 文件结构

```
trans/
├── wrangler.toml
├── package.json
├── src/index.js          # Worker + Room Durable Object (signaling + OpenAI WS proxy)
└── public/
    ├── index.html        # home / create / join / room SPA
    ├── styles.css
    ├── app.js            # 房间状态 + AudioWorklet + WS 上行
    └── pcm-worklet.js    # 把 Float32 → Int16 PCM
```

## 安全提示

- `OPENAI_API_KEY` 是 Worker secret，只在 Worker 运行时进程内存在；浏览器和日志都看不到。
- 房间 12 小时后由 DO alarm 清理；密码以明文比较（仅做"分享受限"用途，非身份认证）。
- 试用配额按"角色（host / guest）× 房间"在内存中累计，DO hibernate 时可能重置——对试用而言无所谓。

## TODO（下一步）

- 用户账户（微信 / 邮件 / Google 登录）+ 充值时长（详见 issue）。
- 自动重连。
- 可选 TTS 朗读译文。

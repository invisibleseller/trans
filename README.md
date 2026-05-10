# 实时同传对话 / Realtime Interpreter Room

1 对 1 实时同传字幕：A 创建房间、B 凭房间号 + 密码加入。两人各说各的语言，对方实时看到 **自己语言** 的字幕。双向。

## 工作方式

```
[Speaker A 浏览器]  ── WebRTC ──> OpenAI Realtime  (A的话 → B的语言文本)
       │
       └── WebSocket ──> Cloudflare Worker (Durable Object) ──> [B 浏览器]
                                ↑
       ┌── WebSocket ──┘
       │
[Speaker B 浏览器]  ── WebRTC ──> OpenAI Realtime  (B的话 → A的语言文本)
```

- **后端**：Cloudflare Workers + Durable Objects（每个房间一个 DO，存房间状态、负责签发 OpenAI 临时 token、转发字幕）。
- **真正的 OpenAI key**：只存在 DO 内存，浏览器拿到的是几分钟有效期的 `client_secret`。
- **房间生命周期**：12 小时自动清理。
- **支持的语言**：中、英、日、德、俄、法（任意源 ↔ 任意目标）。

## 开发

```bash
npm install
npm run dev
# 打开 http://localhost:8787
```

## 部署到 Cloudflare

前置：

1. 注册 Cloudflare 账户（免费档已包含 Durable Objects / SQLite）。
2. 安装 wrangler 并登录：
   ```bash
   npm install
   npx wrangler login
   ```
3. 部署：
   ```bash
   npm run deploy
   ```

部署后会得到形如 `https://realtime-interp.<your-subdomain>.workers.dev` 的 URL。

## 使用

1. A 打开网址 → **创建房间** → 输入自己的 OpenAI API Key、选自己语言、设可选密码 → 进入房间，记下房间号。
2. 把房间号（和密码）发给 B。
3. B 打开网址 → **加入房间** → 填房间号 + 密码 + 自己的语言 → 进入。
4. 双方都点 **开始说话**。
5. A 说话时，B 端"对方说的"区域实时出现 A 的话（以 B 的语言）；反之亦然。

## 安全提示

- OpenAI API Key 只在 A 创建房间那一刻通过 HTTPS 发到 Cloudflare Worker，存在该房间的 Durable Object 内存里，用于向 OpenAI 签发短时 ephemeral token。
- 房间销毁后 key 也随之消失（12 小时 TTL，或所有人离开后下一个 alarm 触发）。
- 进入房间的所有人都能通过浏览器麦克风产生使用量（凭 ephemeral token，不暴露原 key）。请只把房间号 + 密码分享给信任的人，并在 OpenAI 后台为该 key 设上限。

## 文件结构

```
trans/
├── wrangler.toml
├── package.json
├── src/index.js          # Worker + Durable Object
└── public/
    ├── index.html        # home / create / join / room 单页
    ├── styles.css
    └── app.js            # 房间逻辑 + WebRTC + Realtime 事件
```

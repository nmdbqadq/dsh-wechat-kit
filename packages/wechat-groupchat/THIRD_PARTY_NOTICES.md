# Third-party notices

`src/ilink/` and part of `src/qr-png.js` are vendored from MIT-licensed projects
so the plugin can ship without a runtime dependency on `@deepseek-ai/*` packages
or an npm install step.

| Path | Origin | License |
| --- | --- | --- |
| `src/ilink/api.js`, `auth.js`, `monitor.js`, `send.js`, `media.js`, `types.js` | [dsh-wechat](https://github.com/pan17/dsh-wechat) by pan17, itself ported from [wechat-opencode](https://github.com/pan17/wechat-opencode) and `@tencent-weixin/openclaw-weixin` | MIT |
| `src/ilink/secure-fs.js`, `network.js` | dsh-wechat (same origin as above) | MIT |
| `src/ilink/qrcode.mjs` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase | MIT |
| `src/agent-setup.js` (adapted), `src/messages.js` (adapted) | dsh-wechat / `@deepseek-ai/dsh-llm` message helper | MIT |

Each vendored file keeps its original header comment. Algorithmic changes made
here are limited to module paths (the vendored tree is flat) and, in
`agent-setup.js`, to the comments and naming.

Full MIT text:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

This project is not affiliated with Tencent/WeChat or DeepSeek. It uses the same
unofficial iLink bot channel as the projects above; use it at your own risk.

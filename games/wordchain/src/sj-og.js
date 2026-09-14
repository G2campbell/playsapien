const { chromium } = require('playwright');
const fs = require('fs');
const b64 = f => fs.readFileSync('node_modules/@fontsource/fraunces/files/' + f).toString('base64');
const f900 = b64('fraunces-latin-900-normal.woff2'), f400 = b64('fraunces-latin-400-normal.woff2');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Fr;src:url(data:font/woff2;base64,${f900}) format('woff2');font-weight:900}
@font-face{font-family:Fr;src:url(data:font/woff2;base64,${f400}) format('woff2');font-weight:400}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;background:#0C0B0A;display:flex;flex-direction:column;
  align-items:center;justify-content:center;font-family:Fr,serif;color:#F0E8DA;overflow:hidden;position:relative}
.glow{position:absolute;inset:0;background:radial-gradient(60% 70% at 50% 46%,rgba(224,164,74,.16),transparent 70%)}
.globe{margin-bottom:30px;position:relative}
h1{font-weight:900;font-size:124px;letter-spacing:-.022em;line-height:1;position:relative}
p{font-weight:400;font-size:40px;margin-top:18px;color:#C3B9AD;position:relative}
.tag{margin-top:44px;font-weight:400;font-size:24px;letter-spacing:.2em;text-transform:uppercase;
  color:#E0A44A;position:relative}
</style></head><body><div class="glow"></div>
<div class="globe"><svg width="112" height="112" viewBox="0 0 24 24" fill="none" stroke="#E0A44A"
  stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="9.2"/><ellipse cx="12" cy="12" rx="4" ry="9.2"/>
  <path d="M3 9.2h18M3 14.8h18"/></svg></div>
<h1>Sojourner</h1><p>Five places. One unlabelled globe.</p>
<div class="tag">A daily geography game</div>
</body></html>`;
(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await br.newPage({ viewport: { width: 1200, height: 630 } });
  await p.setContent(html); await p.waitForTimeout(600);
  await p.screenshot({ path: 'sojourner-og.png' });
  await br.close(); console.log('ok');
})();

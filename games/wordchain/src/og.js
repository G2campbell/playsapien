const { chromium } = require('playwright');
const fs = require('fs');
const b64 = f => fs.readFileSync('node_modules/@fontsource/fraunces/files/' + f).toString('base64');
const f900 = b64('fraunces-latin-900-normal.woff2');
const f400 = b64('fraunces-latin-400-normal.woff2');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Fr;src:url(data:font/woff2;base64,${f900}) format('woff2');font-weight:900}
@font-face{font-family:Fr;src:url(data:font/woff2;base64,${f400}) format('woff2');font-weight:400}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;background:#D4B072;display:flex;flex-direction:column;
  align-items:center;justify-content:center;font-family:Fr,serif;color:#1F1A14;overflow:hidden}
.mark{margin-bottom:34px}
h1{font-weight:900;font-size:132px;letter-spacing:-.024em;line-height:1}
p{font-weight:400;font-size:44px;margin-top:16px;opacity:.86}
.chain{display:flex;gap:14px;margin-top:52px;font-weight:900;font-size:28px;letter-spacing:.14em;opacity:.5}
.chain span:nth-child(even){opacity:.45;font-weight:400}
</style></head><body>
<div class="mark"><svg width="118" height="118" viewBox="0 0 24 24" fill="none" stroke="#1F1A14"
  stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
  <path d="M10.4 13.6a4.6 4.6 0 0 0 6.94.5l2.76-2.76a4.6 4.6 0 0 0-6.5-6.5l-1.58 1.57"/>
  <path d="M13.6 10.4a4.6 4.6 0 0 0-6.94-.5L3.9 12.66a4.6 4.6 0 0 0 6.5 6.5l1.57-1.57"/></svg></div>
<h1>Word Chain</h1>
<p>Link every word to the next.</p>
<div class="chain"><span>SNOW</span><span>·</span><span>BALL</span><span>·</span><span>PARK</span>
<span>·</span><span>BENCH</span><span>·</span><span>MARK</span><span>·</span><span>UP</span></div>
</body></html>`;

(async () => {
  const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await br.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await p.setContent(html); await p.waitForTimeout(700);
  await p.screenshot({ path: 'dist/og.png' });
  // a square one for chat apps that crop to 1:1
  await p.setViewportSize({ width: 800, height: 800 });
  await p.waitForTimeout(300);
  await p.screenshot({ path: 'dist/icon-512.png' });
  await br.close(); console.log('rendered');
})();

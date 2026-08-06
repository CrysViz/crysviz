// Every palette must stay usable, not merely "different from the last one".
//
// Adding the light themes produced UI text at 1.01:1 against its own
// background and slider thumbs at 1.19:1 — invisible — and nothing caught it.
// themeswitch.test.js proves colours CHANGE; it cannot prove you can still
// read them. Worse, the first fix only checked text, so the controls stayed
// broken through a whole round.
//
// Every failure had one shape: a token doing two jobs.
//   --highlight-color  a pale fill for selected rows AND the slider thumb
//   --danger           a fill with --fg-1 painted on top
//   --ink-3            a text ramp rung used as a switch track
//   --overlay-80       a scrim used as a floating surface
//   --line-1           a hairline used as a slider groove
// On a dark panel one value can serve both roles, which is why none of this
// showed until a light panel existed.
//
// The bar is Default measured in the SAME run, per metric. Default has real
// weak spots (its reset button is ~2.6:1, its switch knob ~1.6:1), so a fixed
// WCAG number would either fail on day one or need Default exempted. "No worse
// than the palette we already ship" is the relationship that matters and does
// not churn when the base palette is retuned.
'use strict';
const H = require('../harness');

const PROBE = () => {
  const lum=(c)=>{const f=(v)=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};
    return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2]);};
  const parse=(s)=>{ s=(s||'').trim();
    if(s[0]==='#'){ const h=s.slice(1); const w=h.length<=4?1:2; const g=(i)=>parseInt(w===1?h[i].repeat(2):h.substr(i*2,2),16);
      return h.length>=3?[g(0),g(1),g(2)]:[]; }
    return (s.match(/[\d.]+/g)||[]).map(Number); };
  const over=(fg,bg)=>{const a=fg.length>3?fg[3]:1;return [0,1,2].map(i=>fg[i]*a+bg[i]*(1-a));};
  const bgOf=(el)=>{let n=el;while(n&&n!==document.documentElement){const c=parse(getComputedStyle(n).backgroundColor);
    if(c.length&&(c.length<4||c[3]>0.55))return c.slice(0,3);n=n.parentElement;}return[0,0,0];};
  const ratio=(a,b)=>{const[h,l]=lum(a)>lum(b)?[lum(a),lum(b)]:[lum(b),lum(a)];return (h+0.05)/(l+0.05);};
  const vis=(el)=>{const b=el.getBoundingClientRect();const cs=getComputedStyle(el);
    return b.width&&b.height&&cs.visibility!=='hidden'&&cs.opacity!=='0';};
  const root=getComputedStyle(document.documentElement);
  const T=(n)=>parse(root.getPropertyValue(n).trim());
  const ui=document.getElementById('ui');
  const worst={};
  const bid=(k,r,l,c,b)=>{ if(!worst[k]||r<worst[k].r) worst[k]={r:+r.toFixed(2),l,c,b}; };

  for(const el of ui.querySelectorAll('*')){
    if(!vis(el))continue;
    const t=[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join('');
    if(!t)continue;
    const bg=bgOf(el);
    bid('text',ratio(over(parse(getComputedStyle(el).color),bg),bg),t.slice(0,20));
  }
  for(const el of ui.querySelectorAll('input[type="range"]')){
    if(!vis(el))continue; const bg=bgOf(el);
    const th=parse(getComputedStyle(el,'::-moz-range-thumb').backgroundColor);
    if(th.length)bid('control',ratio(over(th,bg),bg),'slider thumb',getComputedStyle(el,'::-moz-range-thumb').backgroundColor,JSON.stringify(bg));
  }
  for(const el of ui.querySelectorAll('.toggle_slider')){
    if(!vis(el))continue; const bg=bgOf(el.parentElement);
    const tr=parse(getComputedStyle(el).backgroundColor);
    if(tr.length)bid('control',ratio(over(tr,bg),bg),'switch track',getComputedStyle(el).backgroundColor,JSON.stringify(bg));
    const kn=parse(getComputedStyle(el,'::before').backgroundColor);
    if(kn.length&&tr.length)bid('knob',ratio(over(kn,over(tr,bg)),over(tr,bg)),'knob on track');
  }
  // A text box has to be findable. It reads if EITHER its own fill or its
  // border separates it from the container behind it — so take the better of
  // the two. Every light-theme field once merged into its group box because
  // both came from wash tokens whose alpha was tuned for a dark panel.
  for(const el of ui.querySelectorAll('input:not([type="range"]):not([type="checkbox"]):not([type="radio"]), select, textarea')){
    if(!vis(el))continue;
    const cs=getComputedStyle(el);
    const back=bgOf(el.parentElement);
    const fill=parse(cs.backgroundColor), edge=parse(cs.borderTopColor);
    const hasEdge=parseFloat(cs.borderTopWidth)>0;
    let best=0;
    if(fill.length) best=Math.max(best,ratio(over(fill,back),back));
    if(hasEdge&&edge.length) best=Math.max(best,ratio(over(edge,back),back));
    if(best) bid('field',best,el.tagName.toLowerCase()+' vs container');
  }
  const surf=T('--surface-bg'),pan=T('--panel-bg'),grp=T('--group-bg');
  bid('panel-vs-surface',ratio(over(pan,surf),surf),'panel/surface');
  bid('group-vs-panel',ratio(over(grp,pan),pan),'group/panel');
  return worst;
};

(async () => {
  const { browser, page, errors } = await H.launchApp();
  await H.loadDefaultStructure(page);
  // Expand everything: the worst offenders were in panels that start closed.
  await page.evaluate(() => {
    document.querySelectorAll('.cv-panel-titlebar').forEach((h) => h.click());
  });
  await page.waitForTimeout(800);

  const registry = await page.evaluate(async () => (await fetch('./themes/themes.json')).json());

  async function measure(palette, mode) {
    await page.evaluate((m) => document.querySelector(`.theme-btn[data-theme-option="${m}"]`).click(), mode);
    await page.waitForTimeout(200);
    await page.evaluate((p) => document.querySelector(`.theme-menu-item[data-palette-id="${p}"]`).click(), palette);
    await page.waitForTimeout(700); // theme CSS loads async
    return page.evaluate(PROBE);
  }

  const base = registry.palettes[0];
  const floor = await measure(base.id, Object.keys(base.modes)[0]);
  H.check('the baseline palette measures on every axis (sanity-checks the probe)',
    ['text', 'control', 'knob', 'field', 'panel-vs-surface', 'group-vs-panel']
      .every((k) => floor[k] && floor[k].r > 1), JSON.stringify(floor));

  for (const p of registry.palettes) {
    if (p.id === base.id) continue;
    for (const mode of Object.keys(p.modes)) {
      const got = await measure(p.id, mode);
      // `field` gets an absolute floor, not parity with Default. Its worst case
      // is a different widget in each palette — Default's is a plain field on a
      // group box, a light palette's is a field inside an accent-tinted row —
      // so demanding parity chases a number that moves for unrelated reasons.
      // 1.35 is "you can see where the box is", which is the actual requirement.
      const FIELD_FLOOR = 1.35;
      const bad = Object.keys(floor).filter((k) => {
        if (!got[k]) return false;
        return k === 'field' ? got[k].r < FIELD_FLOOR : got[k].r < floor[k].r - 0.05;
      });
      H.check(`${p.id}/${mode} is no less legible than ${base.id} on any axis`,
        bad.length === 0,
        bad.map((k) => `${k}: ${got[k].r} (${got[k].l}) vs ${floor[k].r}`).join('; ')
          || JSON.stringify(got));
    }
  }

  H.check('no console/page errors', errors.length === 0, errors[0] || '');
  await H.finish(browser);
})().catch(H.crash);

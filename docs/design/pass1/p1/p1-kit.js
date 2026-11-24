window.P1={};
P1.TK={
light:{'surface-0':'oklch(0.975 0.006 85)','surface-1':'oklch(0.995 0.003 85)','surface-2':'oklch(0.952 0.009 85)','surface-3':'oklch(0.918 0.012 85)',
'text-1':'oklch(0.29 0.06 265)','text-2':'oklch(0.44 0.035 262)','text-3':'oklch(0.52 0.025 262)',
'hairline':'oklch(0.29 0.06 265 / 0.10)','hairline-strong':'oklch(0.29 0.06 265 / 0.20)',
'brand':'oklch(0.52 0.08 165)','brand-hover':'oklch(0.46 0.08 165)','brand-tint':'oklch(0.94 0.03 165)','on-brand':'oklch(0.99 0.003 85)',
'critical':'oklch(0.52 0.19 27)','critical-tint':'oklch(0.95 0.03 27)','risk':'oklch(0.74 0.14 70)','risk-text':'oklch(0.50 0.11 62)','risk-tint':'oklch(0.95 0.045 80)',
'ok':'oklch(0.50 0.13 145)','ok-tint':'oklch(0.95 0.04 145)','info':'oklch(0.52 0.14 255)','info-tint':'oklch(0.95 0.025 255)',
'load-1':'oklch(0.29 0.06 265 / 0.05)','load-2':'oklch(0.29 0.06 265 / 0.12)','load-3':'oklch(0.29 0.06 265 / 0.22)','load-4':'oklch(0.29 0.06 265 / 0.34)','over-1':'oklch(0.87 0.09 72)','over-2':'oklch(0.77 0.14 58)','on-over':'oklch(0.25 0.05 50)',
'focus':'oklch(0.52 0.15 255)'},
dark:{'surface-0':'oklch(0.18 0.025 265)','surface-1':'oklch(0.215 0.03 265)','surface-2':'oklch(0.255 0.032 265)','surface-3':'oklch(0.31 0.035 265)',
'text-1':'oklch(0.95 0.008 265)','text-2':'oklch(0.80 0.02 262)','text-3':'oklch(0.70 0.025 262)',
'hairline':'oklch(0.95 0.01 265 / 0.10)','hairline-strong':'oklch(0.95 0.01 265 / 0.20)',
'brand':'oklch(0.74 0.09 165)','brand-hover':'oklch(0.80 0.09 165)','brand-tint':'oklch(0.74 0.09 165 / 0.16)','on-brand':'oklch(0.20 0.03 265)',
'critical':'oklch(0.72 0.16 27)','critical-tint':'oklch(0.72 0.16 27 / 0.16)','risk':'oklch(0.80 0.13 75)','risk-text':'oklch(0.84 0.12 80)','risk-tint':'oklch(0.80 0.13 75 / 0.16)',
'ok':'oklch(0.78 0.14 145)','ok-tint':'oklch(0.78 0.14 145 / 0.16)','info':'oklch(0.74 0.12 255)','info-tint':'oklch(0.74 0.12 255 / 0.16)',
'load-1':'oklch(0.95 0.01 265 / 0.05)','load-2':'oklch(0.95 0.01 265 / 0.11)','load-3':'oklch(0.95 0.01 265 / 0.19)','load-4':'oklch(0.95 0.01 265 / 0.30)','over-1':'oklch(0.70 0.11 72)','over-2':'oklch(0.78 0.14 58)','on-over':'oklch(0.20 0.04 50)',
'focus':'oklch(0.74 0.13 255)'}};
(()=>{const v=o=>Object.entries(o).map(([k,x])=>`--${k}:${x}`).join(';');const s=document.createElement('style');s.textContent=`.frame{${v(P1.TK.light)}}.frame.dark{${v(P1.TK.dark)}}`;document.head.appendChild(s)})();

const I=(n,c='')=>`<i data-lucide="${n}" class="ic ${c}"></i>`;
const AV=(t,c='')=>`<span class="av ${c}">${t}</span>`;
const ST={crit:['▲','Critical'],risk:['◆','At risk'],ok:['✓','On track'],info:['●','Info'],block:['■','Blocked']};
const CHIP=(k,t)=>`<span class="chip ${k==='block'?'crit':k}"><b>${ST[k][0]}</b>${t||ST[k][1]}</span>`;
const PCHIP=t=>`<span class="chip">${t}</span>`;
const DEF={
p80:'P80 finish — 80% of 5,000 simulated schedules finish on or before this date. Recomputed on every schedule change.',
commit:'Commitment — the finish date agreed with the sponsor at baseline (Sep 2). Slip = P80 − commitment, in working days.',
cpm:'CPM date — the deterministic critical-path finish with zero risk applied. The floor, not the forecast.',
load:'Load — hours booked ÷ weekly capacity, after time off. Over 100% means more work than hours.',
crit:'Critical tasks — tasks with zero total float. Engine-computed; cannot be set by hand.',
health:'Health — At risk when P80 is past commitment; Critical when slip > 5 working days.'};
const MET=(l,v,d,asof,vc='t20')=>`<div class="metric"><span class="m-l" data-def="${DEF[d]||d}">${l}</span><span class="${vc}">${v}</span>${asof?`<span class="m-asof">as of ${asof}</span>`:''}</div>`;
Object.assign(window,{I,AV,ST,CHIP,PCHIP,DEF,MET});

P1.rail=(o={})=>{const it=[['home','house','Home'],['inbox','inbox','Inbox',o.inbox],['work','folder-kanban','Work'],['people','users','People'],['agents','bot','Agents',o.agents]];
return `<aside class="rail"><div class="ws"><span class="mark">N</span><span class="lab"><b>Northwind</b><span class="t12 tx3">Workspace</span></span>${o.collapsed?'':I('chevrons-up-down','tx3')}</div>
<nav class="col" style="gap:2px">${it.map(([k,ic,l,b])=>`<a class="ri ${o.active===k?'on':''}">${I(ic)}<span class="lab">${l}</span>${b?`<span class="bdg">${b}</span>`:''}</a>`).join('')}</nav>
${o.pins&&!o.collapsed?`<div class="col lab"><div class="rl">Pinned</div>${o.pins.map(p=>`<a class="ri sub ${o.pinOn===p?'on':''}"><span class="pk">${p[0]}</span><span class="trunc">${p}</span></a>`).join('')}</div>`:''}
<div class="rfoot">${AV(o.ini)}<span class="lab"><b class="trunc">${o.name}</b><span class="t12 tx3">${o.role}</span></span>${o.collapsed?'':I('ellipsis','tx3')}</div></aside>`};
P1.slot=s=>s.k==='ok'?`<span class="slot">${I('check','ok')}Synced 09:12</span>`:`<span class="slot warn">${I(s.ic||'wifi-off')}${s.t}${s.more?`<span class="more">+${s.more}</span>`:''}</span>`;
P1.top=o=>`<header class="top"><nav class="crumbs">${o.crumbs.map((c,i)=>i<o.crumbs.length-1?`<a>${c}</a><span class="sep">/</span>`:`<b>${c}</b>`).join('')}</nav><span class="sp"></span>${o.slot?P1.slot(o.slot):''}<button class="kbtn">${I('search')}<span>Search or run a command</span><kbd>⌘K</kbd></button><button class="btn">${I('plus')}Create</button></header>`;
P1.ctx=o=>`<div class="ctx"><div class="ctx-h"><span class="pk" style="width:24px;height:24px;line-height:24px;font-size:12px">${o.title[0]}</span><h1 class="t20">${o.title}</h1>${CHIP(o.health)}<span class="sp"></span><span class="row t12 tx2"><span class="m-l" data-def="${DEF.p80}">P80</span><span class="b num" style="color:var(--text-1)">Dec 7</span><span>+2d vs commitment</span><span class="tx3">· as of 09:12</span></span></div>
<nav class="tabs">${['Overview','Plan','Deliver','Risks','People'].map(t=>`<a class="tab ${o.tab===t?'on':''}">${t}</a>`).join('')}<a class="tab">More ${I('chevron-down')}</a></nav></div>`;

// forecast S-curve. day 0 = Nov 27
P1.day=d=>d<=3?`Nov ${27+d}`:`Dec ${d-3}`;
const mono=P=>{const n=P.length,dx=[],m=[],t=[];for(let i=0;i<n-1;i++){dx[i]=P[i+1][0]-P[i][0];m[i]=(P[i+1][1]-P[i][1])/dx[i]}t[0]=m[0];t[n-1]=m[n-2];for(let i=1;i<n-1;i++)t[i]=m[i-1]*m[i]<=0?0:3*(dx[i-1]+dx[i])/((2*dx[i]+dx[i-1])/m[i-1]+(dx[i]+2*dx[i-1])/m[i]);
return d=>{let i=0;while(i<n-2&&d>P[i+1][0])i++;const h=dx[i],u=(d-P[i][0])/h,u2=u*u,u3=u2*u;return(2*u3-3*u2+1)*P[i][1]+(u3-2*u2+u)*h*t[i]+(-2*u3+3*u2)*P[i+1][1]+(u3-u2)*h*t[i+1]}};
P1.scurve=(w,h,o={})=>{const f=mono([[0,0],[2,.03],[4,.2],[6,.5],[8,.67],[10,.8],[12,.95],[14,.99],[16,1]]);const D=16,pl=6,pr=6,pt=o.lab===false?6:22,pb=22;
const X=d=>pl+(w-pl-pr)*d/D,Y=p=>pt+(h-pt-pb)*(1-p);let p='';for(let d=0;d<=D;d+=.25)p+=(d?'L':'M')+X(d).toFixed(1)+' '+Y(f(d)).toFixed(1);
const vl=(d,c,dash,wd=1)=>`<line x1="${X(d)}" x2="${X(d)}" y1="${pt-4}" y2="${h-pb}" stroke="${c}" stroke-width="${wd}" ${dash?'stroke-dasharray="3 3"':''}/>`;
const tx=(d,t,c,a='middle',wt=500)=>`<text x="${X(d)}" y="${pt-8}" text-anchor="${a}" fill="${c}" font-size="12" font-weight="${wt}" font-family="Space Grotesk">${t}</text>`;
const ax=[0,4,8,12,16].map(d=>`<text x="${X(d)}" y="${h-6}" text-anchor="${d===0?'start':d===16?'end':'middle'}" fill="var(--text-3)" font-size="12" font-family="JetBrains Mono">${P1.day(d)}</text>`).join('');
return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;overflow:visible" role="img" aria-label="Finish-date S-curve. P50 Dec 3, P80 Dec 7, P95 Dec 9. Commitment Dec 5.">
<rect x="${X(6)}" y="${pt-4}" width="${X(12)-X(6)}" height="${h-pb-pt+4}" fill="var(--load-1)"/>
<line x1="${pl}" x2="${w-pr}" y1="${h-pb}" y2="${h-pb}" stroke="var(--hairline-strong)"/>
${vl(4,'var(--text-3)',true)}${vl(8,'var(--risk)',true,1.5)}${vl(6,'var(--hairline-strong)')}${vl(12,'var(--hairline-strong)')}
<path d="${p} L${X(D)} ${Y(0)} L${X(0)} ${Y(0)} Z" fill="var(--load-1)"/><path d="${p}" fill="none" stroke="var(--text-1)" stroke-width="2"/>
${vl(10,'var(--text-1)',false,2)}<circle cx="${X(10)}" cy="${Y(.8)}" r="4" fill="var(--text-1)" stroke="var(--surface-1)" stroke-width="2"/>
${o.lab===false?'':tx(4,'CPM','var(--text-3)')+tx(6,'P50','var(--text-2)')+tx(8,'Commit','var(--risk-text)')+tx(10,'P80','var(--text-1)','middle',700)+tx(12,'P95','var(--text-2)')}${ax}</svg>`};

P1.WEEKS=['Nov 2','Nov 9','Nov 16','Nov 23','Nov 30','Dec 7','Dec 14','Dec 21'];
P1.PEOPLE=[['Mei Tanaka','MT','Data eng',[92,104,128,110,96,80,72,60]],['Diego Alvarez','DA','Backend',[100,112,106,94,90,92,88,80]],['Sofia Reyes','SR','QA',[40,52,60,72,80,94,108,112]],
['Tom Okafor','TO','Backend',[96,98,100,94,90,86,80,76]],['Liam Chen','LC','Platform',[88,92,96,100,98,74,60,50]],['Ava Patel','AP','Frontend',[84,86,90,92,96,98,100,96]],
['Grace Kim','GK','Security',[72,76,80,84,86,90,92,88]],['Arjun Mehta','AM','Backend',[70,64,62,78,88,90,84,70]],['Hana Sato','HS','Design',[55,60,58,50,46,40,38,30]],['Noah Brooks','NB','Data eng',[30,28,40,44,50,52,48,40]]];
P1.cell=v=>v>115?'o2':v>100?'o1':v>=80?'c4':v>=60?'c3':v>=40?'c2':'c1';
P1.heat=(o={})=>`<div class="hm" role="grid" aria-label="Load by person and week"><div class="hd" style="text-align:left">Person</div>${P1.WEEKS.map(w=>`<div class="hd mono">${w}</div>`).join('')}
${P1.PEOPLE.slice(0,o.n||10).map(([n,i,r,ws],ri)=>`<div class="nm">${AV(i,'s')}<span class="trunc">${n}</span><span class="t12 tx3 trunc">${r}</span></div>${ws.map((v,wi)=>`<div class="cell ${P1.cell(v)} ${o.sel&&ri===0&&wi===2?'sel':''}">${v>100?'▲':''}${v}</div>`).join('')}`).join('')}</div>`;
P1.heatLegend=()=>`<div class="lg"><span><i class="c1"></i>&lt;40%</span><span><i class="c2"></i>40–59</span><span><i class="c3"></i>60–79</span><span><i class="c4"></i>80–100</span><span><i class="o1"></i>▲ 101–115</span><span><i class="o2"></i>▲ &gt;115</span><span class="tx3">Load = booked ÷ capacity, time off removed · as of 09:12</span></div>`;

P1.PROJ=[['Atlas Migration','risk','Dec 7','Dec 5','+2d',6,'Cutover rehearsal','Nov 7','PR'],['Ledger API v2','ok','Nov 24','Nov 27','−3d',3,'General availability','Nov 24','DA'],['Identity Consolidation','ok','Nov 30','Dec 5','−5d',4,'SSO switch','Nov 18','GK']];
P1.icons=()=>window.lucide&&lucide.createIcons({attrs:{'stroke-width':1.75}});

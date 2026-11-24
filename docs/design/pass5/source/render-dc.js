// Pre-render Claude Design .dc.html artboards to static HTML (no runtime script).
// Usage: node render-dc.js <projectDir> <outDir>
// Supports what the Pass 5 frames use: {{a.b}} paths, <sc-for list as>, <sc-if value>,
// <dc-import name theme>, <helmet>, and a DCLogic class with renderVals()/this.props.
'use strict';
const fs = require('fs');
const path = require('path');

const [, , projDir, outDir] = process.argv;
const canvas = JSON.parse(fs.readFileSync(path.join(projDir, 'canvas.json'), 'utf8'));

function parseFile(name) {
  const src = fs.readFileSync(path.join(projDir, name + '.dc.html'), 'utf8');
  const xdc = src.match(/<x-dc>([\s\S]*?)<\/x-dc>/)[1];
  const helmet = (xdc.match(/<helmet>([\s\S]*?)<\/helmet>/) || [, ''])[1];
  const body = xdc.replace(/<helmet>[\s\S]*?<\/helmet>/, '');
  const script = src.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
  const title = (src.match(/<title>([\s\S]*?)<\/title>/) || [, name])[1];
  return { helmet, body, script, title };
}

function vals(script, props) {
  // eslint-disable-next-line no-new-func
  const fn = new Function('props', 'class DCLogic { constructor(p){ this.props = p; } }\n' + script + '\nreturn new Component(props).renderVals();');
  return fn(props);
}

function lookup(scope, expr) {
  const e = expr.trim();
  if (e === 'true') return true;
  if (e === 'false') return false;
  return e.split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope);
}

function interp(text, scope) {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, e) => {
    const v = lookup(scope, e);
    return v == null ? '' : String(v);
  });
}

function findClose(s, tag, from) {
  const open = new RegExp('<' + tag + '[\\s>]', 'g');
  const close = '</' + tag + '>';
  let depth = 1;
  let i = from;
  while (depth > 0) {
    const c = s.indexOf(close, i);
    open.lastIndex = i;
    const o = open.exec(s);
    if (c < 0) throw new Error('unclosed ' + tag);
    if (o && o.index < c) { depth++; i = o.index + 1; } else { depth--; i = c + close.length; if (depth === 0) return c; }
  }
}

function render(s, scope) {
  let out = '';
  let i = 0;
  const re = /<(sc-for|sc-if|dc-import)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(s))) {
    out += interp(s.slice(i, m.index), scope);
    const [tagText, tag, attrs] = m;
    const attr = (n) => { const a = attrs.match(new RegExp(n + '="([^"]*)"')); return a ? a[1] : undefined; };
    const innerStart = m.index + tagText.length;
    const closeAt = findClose(s, tag, innerStart);
    const inner = s.slice(innerStart, closeAt);
    if (tag === 'sc-for') {
      const list = lookup(scope, attr('list').replace(/^\{\{|\}\}$/g, '')) || [];
      const as = attr('as');
      for (const item of list) out += render(inner, Object.assign({}, scope, { [as]: item }));
    } else if (tag === 'sc-if') {
      const v = lookup(scope, attr('value').replace(/^\{\{|\}\}$/g, ''));
      if (v) out += render(inner, scope);
    } else {
      out += renderArtboard(attr('name'), { theme: attr('theme') }).body;
    }
    i = closeAt + ('</' + tag + '>').length;
    re.lastIndex = i;
  }
  return out + interp(s.slice(i), scope);
}

function renderArtboard(name, props) {
  const f = parseFile(name);
  const scope = vals(f.script, props || {});
  return { title: f.title, helmet: f.helmet, body: render(f.body, scope) };
}

fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });
const pages = canvas.pages || [];
const boards = canvas.boards || canvas.artboards || {};
for (const file of Object.keys(boards)) {
  const name = file.replace(/\.dc\.html$/, '');
  const r = renderArtboard(name, {});
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${r.title}</title>
<link rel="stylesheet" href="../css/p4-shared.css">
<link rel="stylesheet" href="../css/p5.css">
${r.helmet.trim()}
</head>
<body>
${r.body.trim()}
</body>
</html>
`;
  fs.writeFileSync(path.join(outDir, 'frames', name + '.html'), html);
}
console.log('rendered', Object.keys(boards).length, 'artboards');
console.log(JSON.stringify({ pages: pages.map((p) => p.id || p.name || p), keys: Object.keys(canvas) }));

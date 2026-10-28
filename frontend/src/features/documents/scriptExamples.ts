/**
 * Ready-made scripts offered in Insert → Script and Settings → Scripts.
 * Script bodies avoid template literals so they can live in plain TS strings.
 */
export type ScriptExample = { name: string; description: string; height: string; html: string; css: string; js: string };

const esc = "const esc = value => String(value ?? '').replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' })[c]);\n";
const shortDate = "const shortDate = value => new Date(String(value).length === 10 ? value + 'T12:00:00' : value).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });\n";

export const scriptExamples: ScriptExample[] = [
  {
    name: "Task counter",
    description: "Task summary by column, refreshed every time it opens.",
    height: "auto",
    html: '<div class="stats"></div>',
    css: ".stats{display:flex;gap:10px;flex-wrap:wrap}.stat{flex:1;min-width:110px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.stat b{display:block;font-size:24px}.stat span{color:var(--muted);font-size:12px}",
    js: "const tasks = await kavot.items('tasks');\nconst groups = {};\nfor (const task of tasks) {\n  const key = task.fields.column || task.fields.status || 'No status';\n  groups[key] = (groups[key] || 0) + 1;\n}\ndocument.querySelector('.stats').innerHTML = Object.entries(groups)\n  .map(([name, count]) => '<div class=\"stat\"><b>' + count + '</b><span>' + name + '</span></div>')\n  .join('') || '<p>No tasks.</p>';",
  },
  {
    name: "Bar chart",
    description: "SVG bar chart of a collection, grouped by a field.",
    height: "auto",
    html: '<label>Collection <select id="collection"></select></label> <label>Field <input id="field" value="status" size="10"></label>\n<svg id="chart" width="100%" height="220"></svg>',
    css: "label{font-size:12px;color:var(--muted);margin-right:8px}select,input{border:1px solid var(--line);border-radius:6px;padding:3px 6px;background:var(--surface)}svg{margin-top:10px}text{fill:var(--ink);font-size:11px}rect{fill:var(--accent)}",
    js: "const select = document.querySelector('#collection');\nconst field = document.querySelector('#field');\nfor (const c of await kavot.collections()) select.add(new Option(c.name, c.id));\nselect.value = 'tasks';\n\nasync function draw() {\n  const items = await kavot.items(select.value);\n  const counts = {};\n  for (const item of items) {\n    const value = item.fields[field.value] ?? '—';\n    counts[value] = (counts[value] || 0) + 1;\n  }\n  const entries = Object.entries(counts);\n  const max = Math.max(1, ...entries.map(e => e[1]));\n  const svg = document.querySelector('#chart');\n  const width = svg.clientWidth || 600, bar = Math.max(18, width / Math.max(entries.length, 1) - 12);\n  svg.innerHTML = entries.map(([label, count], i) => {\n    const h = (count / max) * 160, x = i * (bar + 12);\n    return '<rect x=\"' + x + '\" y=\"' + (180 - h) + '\" width=\"' + bar + '\" height=\"' + h + '\" rx=\"4\"></rect>'\n      + '<text x=\"' + (x + bar / 2) + '\" y=\"' + (172 - h) + '\" text-anchor=\"middle\">' + count + '</text>'\n      + '<text x=\"' + (x + bar / 2) + '\" y=\"200\" text-anchor=\"middle\">' + String(label).slice(0, 14) + '</text>';\n  }).join('');\n}\nselect.onchange = field.onchange = draw;\ndraw();",
  },
  {
    name: "Pomodoro timer",
    description: "25-minute timer, fully local.",
    height: "auto",
    html: '<div class="timer"><output>25:00</output><button id="start">Start</button><button id="reset">Reset</button></div>',
    css: ".timer{display:flex;align-items:center;gap:10px}output{font:600 28px ui-monospace,monospace;min-width:110px}",
    js: "let left = 25 * 60, timer = null;\nconst out = document.querySelector('output');\nconst show = () => out.textContent = String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0');\ndocument.querySelector('#start').onclick = event => {\n  if (timer) { clearInterval(timer); timer = null; event.target.textContent = 'Resume'; return; }\n  event.target.textContent = 'Pause';\n  timer = setInterval(() => { left = Math.max(0, left - 1); show(); if (!left) { clearInterval(timer); kavot.toast('Pomodoro finished'); } }, 1000);\n};\ndocument.querySelector('#reset').onclick = () => { left = 25 * 60; show(); };",
  },
  {
    name: "Table of contents",
    description: "Clickable outline of the note’s headings.",
    height: "auto",
    html: '<nav id="toc"></nav>',
    css: "nav{font-size:13px}a{display:block;padding:3px 6px;border-radius:5px;color:var(--ink);text-decoration:none;cursor:pointer}a:hover{background:var(--surface-soft);color:var(--accent)}.l2{padding-left:18px}.l3{padding-left:32px;color:var(--muted)}.l4{padding-left:46px;color:var(--muted);font-size:12px}p{color:var(--muted);margin:0}",
    js: esc + "async function render() {\n  const note = await kavot.note();\n  const toc = document.querySelector('#toc');\n  if (!note.headings.length) { toc.innerHTML = '<p>Add headings to the note to build the outline.</p>'; return; }\n  toc.innerHTML = note.headings.map(h => '<a class=\"l' + h.level + '\" data-id=\"' + esc(h.id) + '\">' + esc(h.text) + '</a>').join('');\n}\ndocument.addEventListener('click', event => {\n  const link = event.target.closest('a[data-id]');\n  if (link) kavot.scrollTo(link.dataset.id);\n});\nrender();\nsetInterval(render, 4000);",
  },
  {
    name: "Note statistics",
    description: "Words, characters, headings and estimated reading time.",
    height: "auto",
    html: '<div class="grid"></div>',
    css: ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}.stat{padding:10px 12px;border:1px solid var(--line);border-radius:9px}.stat b{display:block;font-size:20px}.stat span{color:var(--muted);font-size:12px}",
    js: "async function render() {\n  const note = await kavot.note();\n  const minutes = Math.max(1, Math.round(note.words / 230));\n  const stats = [[note.words.toLocaleString('en-US'), 'words'], [note.text.length.toLocaleString('en-US'), 'characters'], [note.headings.length, 'headings'], [minutes + ' min', 'reading time']];\n  document.querySelector('.grid').innerHTML = stats.map(s => '<div class=\"stat\"><b>' + s[0] + '</b><span>' + s[1] + '</span></div>').join('');\n}\nrender();\nsetInterval(render, 5000);",
  },
  {
    name: "Upcoming deadlines",
    description: "Tasks due in the coming days, overdue ones in red.",
    height: "auto",
    html: '<label>Within <select id="days"><option value="7">7 days</option><option value="14" selected>14 days</option><option value="30">30 days</option><option value="90">90 days</option></select></label>\n<ul id="list"></ul>',
    css: "label{color:var(--muted);font-size:12px}select{border:1px solid var(--line);border-radius:6px;background:var(--surface);padding:2px 6px}ul{list-style:none;margin:8px 0 0;padding:0}li{display:flex;gap:10px;align-items:center;padding:7px 4px;border-top:1px solid var(--line);cursor:pointer}li:hover{background:var(--surface-soft)}li b{flex:1;font-weight:500}time{min-width:70px;color:var(--muted);font-size:12px}.late time{color:var(--red);font-weight:600}.pill{font-size:11px;padding:0 7px;border-radius:999px;background:var(--surface-soft);color:var(--muted)}.empty{color:var(--muted);border:0;cursor:default}",
    js: esc + shortDate + "const days = document.querySelector('#days');\nlet tasks = [];\nfunction render() {\n  const today = new Date(); today.setHours(0, 0, 0, 0);\n  const limit = new Date(today); limit.setDate(limit.getDate() + Number(days.value));\n  const done = t => /done|termin/i.test(t.fields.column || '') || t.fields.status === 'done';\n  const due = tasks.filter(t => t.fields.due_date && !done(t)).map(t => ({ t, date: new Date(t.fields.due_date + 'T00:00:00') }))\n    .filter(x => x.date <= limit).sort((a, b) => a.date - b.date);\n  document.querySelector('#list').innerHTML = due.map((x, i) => '<li data-i=\"' + i + '\" class=\"' + (x.date < today ? 'late' : '') + '\"><time>' + shortDate(x.t.fields.due_date) + '</time><b>' + esc(x.t.title) + '</b>' + (x.t.fields.project ? '<span class=\"pill\">' + esc(x.t.fields.project) + '</span>' : '') + '</li>').join('') || '<li class=\"empty\">No deadlines in this period.</li>';\n  document.querySelectorAll('li[data-i]').forEach(li => li.onclick = () => kavot.open(due[li.dataset.i].t));\n}\ndays.onchange = render;\ntasks = await kavot.items('tasks');\nrender();",
  },
  {
    name: "Task progress",
    description: "Progress bar of completed tasks, per project.",
    height: "auto",
    html: '<label>Project <select id="project"><option value="">All projects</option></select></label>\n<div class="bar"><div class="fill"></div></div>\n<p id="label"></p>',
    css: "label{color:var(--muted);font-size:12px}select{border:1px solid var(--line);border-radius:6px;background:var(--surface);padding:2px 6px}.bar{height:12px;margin:12px 0 6px;border-radius:999px;background:var(--surface-soft);overflow:hidden}.fill{height:100%;width:0;border-radius:inherit;background:var(--accent);transition:width .4s}p{margin:0;color:var(--muted);font-size:12px}",
    js: "const tasks = await kavot.items('tasks');\nconst select = document.querySelector('#project');\nfor (const name of [...new Set(tasks.map(t => t.fields.project).filter(Boolean))].sort()) select.add(new Option(name, name));\nfunction render() {\n  const list = tasks.filter(t => !select.value || t.fields.project === select.value);\n  const done = list.filter(t => /done|termin/i.test(t.fields.column || '') || t.fields.status === 'done').length;\n  const ratio = list.length ? Math.round(done / list.length * 100) : 0;\n  document.querySelector('.fill').style.width = ratio + '%';\n  document.querySelector('#label').textContent = ratio + ' % · ' + done + ' of ' + list.length + ' task' + (list.length === 1 ? '' : 's') + ' completed' + list.length;\n}\nselect.onchange = render;\nrender();",
  },
  {
    name: "Monthly calendar",
    description: "Task deadlines and conference dates on a monthly calendar.",
    height: "auto",
    html: '<header><button id="prev" aria-label="Previous month">‹</button><strong id="month"></strong><button id="next" aria-label="Next month">›</button></header>\n<div class="grid" id="grid"></div>',
    css: "header{display:flex;align-items:center;gap:8px;margin-bottom:8px}header strong{flex:1;text-align:center;text-transform:capitalize}.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}.head{color:var(--muted);font-size:11px;text-align:center}.day{min-height:62px;padding:3px;border:1px solid var(--line);border-radius:6px;font-size:11px;overflow:hidden}.day.out{opacity:.4}.day.today{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}.num{color:var(--muted)}.ev{display:block;margin-top:2px;padding:1px 4px;border-radius:4px;background:var(--accent-soft);color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}.ev.conf{background:color-mix(in srgb,var(--amber) 18%,transparent);color:var(--amber)}",
    js: esc + "const [tasks, conferences] = await Promise.all([kavot.items('tasks'), kavot.items('conferences')]);\nconst events = [...tasks.filter(t => t.fields.due_date).map(t => ({ item: t, date: String(t.fields.due_date).slice(0, 10), kind: 'task' })),\n  ...conferences.filter(c => c.fields.starts_at).map(c => ({ item: c, date: String(c.fields.starts_at).slice(0, 10), kind: 'conf' }))];\nconst key = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');\nlet cursor = new Date(); cursor.setDate(1);\nfunction render() {\n  document.querySelector('#month').textContent = cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });\n  const start = new Date(cursor); start.setDate(1 - ((cursor.getDay() + 6) % 7));\n  const today = key(new Date());\n  let html = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => '<div class=\"head\">' + d + '</div>').join('');\n  for (let i = 0; i < 42; i++) {\n    const day = new Date(start); day.setDate(start.getDate() + i);\n    const list = events.map((e, index) => ({ e, index })).filter(x => x.e.date === key(day));\n    html += '<div class=\"day' + (day.getMonth() !== cursor.getMonth() ? ' out' : '') + (key(day) === today ? ' today' : '') + '\"><span class=\"num\">' + day.getDate() + '</span>' + list.map(x => '<span class=\"ev ' + x.e.kind + '\" data-i=\"' + x.index + '\" title=\"' + esc(x.e.item.title) + '\">' + esc(x.e.item.title) + '</span>').join('') + '</div>';\n  }\n  document.querySelector('#grid').innerHTML = html;\n}\ndocument.addEventListener('click', event => {\n  const ev = event.target.closest('.ev');\n  if (ev) kavot.open(events[ev.dataset.i].item);\n});\ndocument.querySelector('#prev').onclick = () => { cursor.setMonth(cursor.getMonth() - 1); render(); };\ndocument.querySelector('#next').onclick = () => { cursor.setMonth(cursor.getMonth() + 1); render(); };\nrender();",
  },
  {
    name: "Countdown",
    description: "Time left before a date (edit data-date in the HTML tab).",
    height: "auto",
    html: '<div id="countdown" data-date="2026-12-31T18:00" data-label="Submission deadline"></div>',
    css: "#countdown{text-align:center}.label{color:var(--muted);font-size:12px;margin-bottom:6px}.units{display:flex;justify-content:center;gap:10px}.unit{min-width:64px;padding:8px;border:1px solid var(--line);border-radius:9px}.unit b{display:block;font:600 24px ui-monospace,monospace}.unit span{color:var(--muted);font-size:11px}.over{color:var(--red);font-weight:600}",
    js: "const box = document.querySelector('#countdown');\nconst target = new Date(box.dataset.date);\nfunction tick() {\n  let left = Math.max(0, target - new Date());\n  if (!left) { box.innerHTML = '<div class=\"label\">' + box.dataset.label + '</div><div class=\"over\">Deadline reached</div>'; return; }\n  const parts = [[86400000, 'days'], [3600000, 'hours'], [60000, 'minutes'], [1000, 'seconds']].map(([ms, name]) => { const n = Math.floor(left / ms); left -= n * ms; return [n, name]; });\n  box.innerHTML = '<div class=\"label\">' + box.dataset.label + ' · ' + target.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }) + '</div><div class=\"units\">' + parts.map(p => '<div class=\"unit\"><b>' + p[0] + '</b><span>' + p[1] + '</span></div>').join('') + '</div>';\n}\ntick();\nsetInterval(tick, 1000);",
  },
  {
    name: "Reading list",
    description: "Articles to read or being read.",
    height: "auto",
    html: '<div class="tabs"><button data-status="to_read" class="on">To read</button><button data-status="reading">Reading</button><button data-status="key">Key</button></div>\n<ul id="list"></ul>',
    css: ".tabs{display:flex;gap:4px;margin-bottom:6px}.tabs button.on{background:var(--accent-soft);color:var(--accent);border-color:var(--accent)}ul{list-style:none;margin:0;padding:0}li{padding:7px 4px;border-top:1px solid var(--line);cursor:pointer}li:hover{background:var(--surface-soft)}li b{display:block;font-weight:500}li small{color:var(--muted)}.empty{color:var(--muted);cursor:default}",
    js: esc + "const articles = await kavot.items('articles');\nlet status = 'to_read';\nfunction render() {\n  const list = articles.filter(a => (a.fields.status || 'to_read') === status);\n  document.querySelector('#list').innerHTML = list.map((a, i) => '<li data-i=\"' + i + '\"><b>' + esc(a.title) + '</b><small>' + esc([].concat(a.fields.authors || []).slice(0, 3).join(', ')) + (a.fields.year ? ' · ' + a.fields.year : '') + '</small></li>').join('') || '<li class=\"empty\">No articles.</li>';\n  document.querySelectorAll('li[data-i]').forEach(li => li.onclick = () => kavot.open(list[li.dataset.i]));\n}\ndocument.querySelectorAll('[data-status]').forEach(button => button.onclick = () => {\n  status = button.dataset.status;\n  document.querySelectorAll('[data-status]').forEach(b => b.classList.toggle('on', b === button));\n  render();\n});\nrender();",
  },
  {
    name: "Sortable table",
    description: "Any collection as a table: sort by column and search.",
    height: "auto",
    html: '<div class="bar"><select id="collection"></select><input id="search" type="search" placeholder="Search…"></div>\n<div class="wrap"><table id="table"></table></div>',
    css: ".bar{display:flex;gap:6px;margin-bottom:8px}select,input{border:1px solid var(--line);border-radius:6px;background:var(--surface);padding:3px 8px}input{flex:1}.wrap{max-height:420px;overflow:auto}th{position:sticky;top:0;background:var(--surface);cursor:pointer;white-space:nowrap}th.asc::after{content:' ▲'}th.desc::after{content:' ▼'}td{white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}tbody tr{cursor:pointer}tbody tr:hover{background:var(--surface-soft)}",
    js: esc + "const select = document.querySelector('#collection');\nfor (const c of await kavot.collections()) select.add(new Option(c.name, c.id));\nlet items = [], columns = [], sort = { key: 'title', dir: 1 };\nconst value = (item, key) => key === 'title' ? item.title : [].concat(item.fields[key] ?? '').join(', ');\nasync function load() {\n  items = await kavot.items(select.value);\n  const keys = new Set();\n  items.slice(0, 50).forEach(i => Object.keys(i.fields).forEach(k => { if (!k.startsWith('@')) keys.add(k); }));\n  columns = ['title', ...[...keys].slice(0, 6)];\n  render();\n}\nfunction render() {\n  const q = document.querySelector('#search').value.toLowerCase();\n  const rows = items.filter(i => !q || columns.some(k => value(i, k).toLowerCase().includes(q)))\n    .sort((a, b) => value(a, sort.key).localeCompare(value(b, sort.key), 'en', { numeric: true }) * sort.dir);\n  document.querySelector('#table').innerHTML = '<thead><tr>' + columns.map(k => '<th data-key=\"' + k + '\" class=\"' + (sort.key === k ? (sort.dir > 0 ? 'asc' : 'desc') : '') + '\">' + (k === 'title' ? 'Title' : esc(k)) + '</th>').join('') + '</tr></thead><tbody>'\n    + rows.map((r, i) => '<tr data-i=\"' + i + '\">' + columns.map(k => '<td>' + esc(value(r, k)) + '</td>').join('') + '</tr>').join('') + '</tbody>';\n  document.querySelectorAll('th').forEach(th => th.onclick = () => { sort = { key: th.dataset.key, dir: sort.key === th.dataset.key ? -sort.dir : 1 }; render(); });\n  document.querySelectorAll('tbody tr').forEach(tr => tr.onclick = () => kavot.open(rows[tr.dataset.i]));\n}\nselect.onchange = load;\ndocument.querySelector('#search').oninput = render;\nselect.value = 'tasks';\nload();",
  },
  {
    name: "Tag cloud",
    description: "Most used tags in a collection.",
    height: "auto",
    html: '<select id="collection"></select>\n<div id="cloud"></div>',
    css: "select{border:1px solid var(--line);border-radius:6px;background:var(--surface);padding:3px 8px}#cloud{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline;margin-top:10px}#cloud span{color:var(--accent);line-height:1.2}#cloud small{color:var(--muted);font-size:10px;margin-left:2px}p{color:var(--muted)}",
    js: esc + "const select = document.querySelector('#collection');\nfor (const c of await kavot.collections()) select.add(new Option(c.name, c.id));\nasync function render() {\n  const counts = {};\n  for (const item of await kavot.items(select.value))\n    for (const key of ['labels', 'tags', 'keywords']) for (const tag of [].concat(item.fields[key] || [])) if (tag) counts[tag] = (counts[tag] || 0) + 1;\n  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 60);\n  const max = Math.max(1, ...entries.map(e => e[1]));\n  document.querySelector('#cloud').innerHTML = entries.map(e => '<span style=\"font-size:' + (12 + 16 * e[1] / max) + 'px\">' + esc(e[0]) + '<small>' + e[1] + '</small></span>').join('') || '<p>No tags in this collection.</p>';\n}\nselect.onchange = render;\nselect.value = 'tasks';\nrender();",
  },
  {
    name: "Calculatrice",
    description: "Quick calculations with history; accepts + − × ÷ ( ) % and ^.",
    height: "auto",
    html: '<form id="calc"><input id="expr" autocomplete="off" placeholder="(12 + 8) × 1.5"><button>=</button></form>\n<ol id="history"></ol>',
    css: "form{display:flex;gap:6px}input{flex:1;border:1px solid var(--line);border-radius:6px;background:var(--surface);padding:5px 9px;font-family:ui-monospace,monospace}ol{list-style:none;margin:8px 0 0;padding:0;font-family:ui-monospace,monospace;font-size:13px}li{display:flex;justify-content:space-between;padding:3px 2px;border-top:1px solid var(--line)}li b{color:var(--accent)}.error{color:var(--red)}",
    js: "const input = document.querySelector('#expr');\ndocument.querySelector('#calc').onsubmit = event => {\n  event.preventDefault();\n  const source = input.value.trim();\n  if (!source) return;\n  const expr = source.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/,/g, '.').replace(/\\^/g, '**');\n  let result;\n  if (!/^[\\d+\\-*/().%\\s]+$/.test(expr)) result = '<span class=\"error\">Invalid expression</span>';\n  else { try { result = '<b>' + Number(Function('return (' + expr + ')')()).toLocaleString('en-US', { maximumFractionDigits: 10 }) + '</b>'; } catch { result = '<span class=\"error\">Invalid expression</span>'; } }\n  const li = document.createElement('li');\n  li.innerHTML = '<span></span>' + result;\n  li.firstChild.textContent = source;\n  document.querySelector('#history').prepend(li);\n  input.value = '';\n};",
  },
];

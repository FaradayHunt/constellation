const fs = require('fs');
const path = require('path');
const { loadBrain } = require('./lib/core');
const data = loadBrain();
// Strip embeddings + merged nodes for portal, map tier → isCore/isSingularity
data.nodes = data.nodes.filter(n => !n.mergedInto);
data.nodes.forEach(n => {
  delete n.embedding;
  // Map tier system to boolean flags for portal compatibility
  if (n.tier === 'singularity') { n.isCore = true; n.isSingularity = true; }
  else if (n.tier === 'core') { n.isCore = true; n.isSingularity = false; }
  else { n.isCore = false; n.isSingularity = false; }
});

// Load RAG doc chunks and inject as special nodes
const RAG_PATH = path.join(__dirname, 'rag-store.json');
let ragDocCount = 0;
if (fs.existsSync(RAG_PATH)) {
  const rag = JSON.parse(fs.readFileSync(RAG_PATH, 'utf8'));
  ragDocCount = rag.documents?.length || 0;
  (rag.chunks || []).forEach(chunk => {
    delete chunk.embedding;
    data.nodes.push({
      id: 'rag_' + chunk.id,
      text: chunk.text,
      tier: 'doc',
      isCore: false,
      isSingularity: false,
      isDoc: true,
      docSource: chunk.source,
      tags: ['doc', chunk.source],
      usage: { hits: 0 },
      sourceFile: chunk.source
    });
  });
}

const entityCount = new Set(data.nodes.flatMap(n => n.entities || [])).size;
const todos = JSON.parse(fs.readFileSync(path.join(__dirname, 'todos.json'), 'utf8'));

function getLabel(n) {
  let t = (n.text || n.id).replace(/^##\s*/, '').replace(/\n.*/s, '').trim();
  if (t.length > 40) t = t.substring(0, 38) + '…';
  return t;
}

const SHARED_HEAD = `<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">`;

const SHARED_CSS = `
:root {
  --ui-bg: #0a0d12;
  --ui-bg-elevated: #121a26;
  --ui-bg-accented: #162236;
  --ui-text-dimmed: rgba(248,250,252,0.55);
  --ui-text-muted: rgba(248,250,252,0.72);
  --ui-text-toned: rgba(248,250,252,0.84);
  --ui-text: rgba(248,250,252,0.92);
  --ui-text-highlighted: #ffffff;
  --ui-border: rgba(248,250,252,0.12);
  --ui-border-muted: rgba(248,250,252,0.08);
  --ui-border-accented: rgba(248,250,252,0.16);
  --ui-shell: rgba(18,26,38,0.70);
  --shadow-shell: 0 24px 64px rgba(0,0,0,0.45);
  --shadow-card: 0 12px 40px rgba(0,0,0,0.35);
  --shadow-soft: 0 6px 24px rgba(0,0,0,0.25);
  --radius: 0.5rem;
  --radius-xl: 0.75rem;
  --radius-shell: 1rem;
}
*{margin:0;padding:0;box-sizing:border-box}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(248,250,252,0.08);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:rgba(248,250,252,0.15)}
::-webkit-scrollbar-corner{background:transparent}

/* WALLPAPER — gradient viewport */
body{
  font-family:'Plus Jakarta Sans',ui-sans-serif,system-ui,-apple-system,sans-serif;
  font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;
  background: radial-gradient(900px 560px at 15% -10%, rgba(86,140,255,0.20), transparent 55%),
              radial-gradient(900px 560px at 100% 0%, rgba(255,164,120,0.12), transparent 55%),
              var(--ui-bg);
  background-attachment:fixed;
  color:var(--ui-text);
  height:100vh;overflow:hidden;
  padding:16px; /* gradient peeks out on all sides */
}

/* SHELL — frosted floating window */
.shell{
  width:100%;max-width:1480px;
  min-height:calc(100vh - 2rem);margin:0 auto;
  background:var(--ui-shell);
  border:1px solid var(--ui-border-muted);
  border-radius:var(--radius-shell);
  box-shadow:var(--shadow-shell);
  backdrop-filter:blur(26px);
  display:flex;flex-direction:row;
  overflow:hidden;
}

/* SIDEBAR — inside the shell */
.sb{
  width:56px;flex-shrink:0;
  border-right:1px solid var(--ui-border-muted);
  display:flex;flex-direction:column;
  padding:8px 0;
}
.sb-logo{
  height:48px;display:flex;align-items:center;justify-content:center;
  font-size:15px;font-weight:800;color:var(--ui-text-highlighted);
  margin-bottom:8px;
}
.sb-nav{flex:1;display:flex;flex-direction:column;gap:2px}
.sb-item{
  display:flex;align-items:center;justify-content:center;
  height:40px;width:40px;margin:0 auto;border-radius:var(--radius);
  color:var(--ui-text-dimmed);text-decoration:none;transition:all .15s;
  position:relative;
}
.sb-item:hover{color:var(--ui-text);background:rgba(255,255,255,0.04)}
.sb-item.active{color:var(--ui-text-highlighted);background:rgba(255,255,255,0.06)}
.sb-item.active::after{
  content:'';position:absolute;right:-8px;top:50%;transform:translateY(-50%);
  width:3px;height:16px;border-radius:3px 0 0 3px;background:var(--ui-text-highlighted);opacity:0.6;
}
.sb-item.disabled{opacity:0.2;pointer-events:none}
.sb-bottom{border-top:1px solid var(--ui-border-muted);padding-top:8px;display:flex;justify-content:center}
.sb-avatar{
  width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,0.06);
  border:1px solid var(--ui-border-accented);display:flex;align-items:center;
  justify-content:center;font-size:10px;font-weight:700;color:var(--ui-text-muted);
}

/* CONTENT area */
.content{flex:1;display:flex;flex-direction:column;min-width:0;position:relative}
.content-header{
  height:56px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;
  padding:0 20px;border-bottom:1px solid var(--ui-border-muted);
}
.content-header h1{font-size:14px;font-weight:600;letter-spacing:-0.02em}
.content-body{flex:1;min-height:0;overflow:auto;position:relative}

/* AUTH — smaller shell */
.shell-auth{
  width:100%;max-width:400px;min-height:auto;
  padding:32px;text-align:center;
  display:flex;flex-direction:column;align-items:center;
}
.shell-auth h1{font-size:20px;font-weight:700;letter-spacing:-0.02em;color:var(--ui-text-highlighted);margin-bottom:4px}
.shell-auth p{font-size:11px;color:var(--ui-text-dimmed);margin-bottom:24px;text-transform:uppercase;letter-spacing:0.2em;font-weight:600}
.shell-auth input[type=password]{
  display:block;width:100%;padding:10px 14px;background:rgba(255,255,255,0.05);border:1px solid var(--ui-border-muted);
  border-radius:var(--radius);color:var(--ui-text);font-size:13px;
  font-family:'Plus Jakarta Sans',sans-serif;outline:none;text-align:center;transition:border-color .2s;box-sizing:border-box;
}
.shell-auth input[type=password]:focus{border-color:rgba(59,130,246,0.25);box-shadow:0 0 0 3px rgba(59,130,246,0.18)}
.shell-auth input::placeholder{color:var(--ui-text-dimmed)}
.shell-auth button{
  width:100%;margin-top:12px;padding:10px;border:none;border-radius:var(--radius);
  font-size:12px;font-weight:600;font-family:'Plus Jakarta Sans',sans-serif;
  letter-spacing:0.05em;cursor:pointer;transition:all .15s;
  background:linear-gradient(-45deg,rgba(86,140,255,0.35),rgba(255,164,120,0.30),rgba(86,140,255,0.35));
  background-size:300% 300%;animation:cta 8s ease-in-out infinite;color:var(--ui-text);
}
@keyframes cta{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
.shell-auth .remember{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:14px;font-size:11px;color:var(--ui-text-dimmed)}
.shell-auth .remember input[type=checkbox]{accent-color:#3b82f6;width:14px;height:14px;cursor:pointer}
.lerr{color:#ef4444;font-size:11px;margin-top:8px;opacity:0;transition:opacity .3s}.lerr.s{opacity:1}
`;

const SIDEBAR_HTML = `
<div class="sb">
  <div class="sb-logo">M</div>
  <div class="sb-nav">
    <a href="core.html" class="sb-item" data-page="core" title="Core">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.58.7 3 1.81 4A5.5 5.5 0 0 0 4 15.5 5.5 5.5 0 0 0 9.5 21h.5"/><path d="M14.5 2A5.5 5.5 0 0 1 20 7.5c0 1.58-.7 3-1.81 4A5.5 5.5 0 0 1 20 15.5a5.5 5.5 0 0 1-5.5 5.5H14"/><path d="M12 2v19"/></svg>
    </a>
    <a href="team.html" class="sb-item" data-page="team" title="Team">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
    </a>
    <a href="todo.html" class="sb-item" data-page="todo" title="Todo">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
    </a>
    <a href="#" class="sb-item disabled" title="Timeline">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    </a>
    <a href="#" class="sb-item disabled" title="Inbox">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
    </a>
  </div>
  <div class="sb-bottom"><div class="sb-avatar">V</div></div>
</div>`;

const AUTH_JS = `
function doLogin(){
  if(document.getElementById('pwd').value==='mother2026'){
    if(document.getElementById('rememberMe').checked)localStorage.setItem('portal_auth','1');
    document.getElementById('loginWrap').style.display='none';
    document.getElementById('appWrap').style.display='block';
    if(typeof onAuth==='function')setTimeout(onAuth,100);
  }else{
    document.getElementById('lerr').classList.add('s');document.getElementById('pwd').value='';
    setTimeout(()=>document.getElementById('lerr').classList.remove('s'),2000);
  }
}
document.getElementById('pwd').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()});
if(localStorage.getItem('portal_auth')==='1'){
  document.getElementById('loginWrap').style.display='none';
  document.getElementById('appWrap').style.display='block';
  if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',()=>setTimeout(onAuth,50));
  else setTimeout(onAuth,50);
}
`;

// ========== BRAIN PAGE ==========
const brainHtml = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
${SHARED_HEAD}
<title>Brain — Mother's Portal</title>
<style>
${SHARED_CSS}

/* Brain-specific */
#loginWrap{display:flex;align-items:center;justify-content:center;height:100%}
#appWrap{display:none;height:100%}
canvas{width:100%;height:100%;display:block}

.stats-bar{position:absolute;bottom:16px;left:16px;display:flex;gap:16px;z-index:10;
  background:rgba(18,26,38,0.6);border:1px solid var(--ui-border-muted);
  border-radius:var(--radius-xl);padding:6px 14px;backdrop-filter:blur(16px)}
.st{display:flex;align-items:baseline;gap:4px}
.st b{font-size:13px;font-weight:700;color:var(--ui-text-highlighted);font-variant-numeric:tabular-nums;letter-spacing:-0.02em}
.st small{font-size:8px;text-transform:uppercase;letter-spacing:0.15em;font-weight:600;color:var(--ui-text-dimmed)}

.search-bar{position:absolute;top:16px;right:16px;z-index:10}
.search-bar input{
  background:rgba(18,26,38,0.6);border:1px solid var(--ui-border-muted);
  border-radius:var(--radius);padding:6px 12px;backdrop-filter:blur(16px);
  color:var(--ui-text);font-size:11px;font-family:'Plus Jakarta Sans',sans-serif;
  outline:none;width:150px}
.search-bar input::placeholder{color:var(--ui-text-dimmed)}

#detail{position:absolute;top:50%;right:-360px;transform:translateY(-50%);width:320px;max-height:65vh;
  background:linear-gradient(180deg,rgba(18,26,38,0.92),rgba(18,26,38,0.75));
  border:1px solid var(--ui-border-muted);border-radius:var(--radius-xl);
  padding:18px;z-index:20;overflow-y:auto;box-shadow:var(--shadow-card);
  backdrop-filter:blur(26px);transition:right .25s ease}
#detail.open{right:16px}
#detail .x{position:absolute;top:8px;right:10px;background:rgba(255,255,255,0.05);border:1px solid var(--ui-border-muted);
  border-radius:var(--radius);width:26px;height:26px;display:flex;align-items:center;justify-content:center;
  color:var(--ui-text-dimmed);font-size:11px;cursor:pointer;transition:all .15s}
#detail .x:hover{background:rgba(255,255,255,0.08);color:var(--ui-text)}
#detail h2{font-size:12px;font-weight:600;color:var(--ui-text);letter-spacing:-0.02em;margin-bottom:6px;line-height:1.5;margin-right:30px}
#detail .mt{font-size:10px;line-height:1.7;color:var(--ui-text-muted);margin-bottom:12px;white-space:pre-wrap;max-height:120px;overflow-y:auto}
#detail .tags{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:8px}
#detail .tg{padding:2px 7px;border-radius:var(--radius);font-size:8px;font-weight:600;background:rgba(255,255,255,0.04);border:1px solid var(--ui-border-muted);color:var(--ui-text-dimmed)}
#detail .meta{font-size:9px;color:var(--ui-text-dimmed);margin-bottom:12px}
#detail h3{font-size:9px;font-weight:600;color:var(--ui-text-dimmed);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.15em}
#detail .cn{padding:4px 0;border-bottom:1px solid var(--ui-border-muted);font-size:10px;color:var(--ui-text-muted);cursor:pointer;transition:color .15s}
#detail .cn:hover{color:var(--ui-text-highlighted)}

#tip{position:fixed;background:rgba(18,26,38,0.92);border:1px solid var(--ui-border-muted);border-radius:var(--radius);
  padding:5px 9px;font-size:9px;color:var(--ui-text-muted);pointer-events:none;z-index:30;max-width:200px;
  opacity:0;transition:opacity .12s;backdrop-filter:blur(16px)}
#tip.s{opacity:1}
</style>
</head>
<body>

<!-- AUTH -->
<div id="loginWrap">
  <div class="shell shell-auth" style="margin:auto">
    <h1>Mother's Portal</h1>
    <p>Neural Command Center</p>
    <input type="password" id="pwd" placeholder="Password" autofocus>
    <button onclick="doLogin()">ENTER</button>
    <label class="remember"><input type="checkbox" id="rememberMe" checked> Remember me</label>
    <div class="lerr" id="lerr">Access denied</div>
  </div>
</div>

<!-- APP -->
<div id="appWrap">
  <div class="shell">
    ${SIDEBAR_HTML}
    <div class="content">
      <div class="content-header">
        <h1>Brain</h1>
        <div style="display:flex;align-items:center;gap:10px">
          <div class="search-bar" style="position:static"><input type="text" id="si" placeholder="Search…"></div>
          <button onclick="openMem()" style="padding:6px 12px;border-radius:var(--radius);font-size:10px;font-weight:600;background:linear-gradient(-45deg,rgba(86,140,255,0.30),rgba(255,164,120,0.25));border:1px solid rgba(86,140,255,0.15);color:var(--ui-text);cursor:pointer;font-family:'Plus Jakarta Sans',sans-serif;white-space:nowrap">+ Memory</button>
          <span id="pendingBadge" style="display:none;font-size:9px;color:var(--ui-text-dimmed);background:rgba(255,255,255,0.05);padding:2px 8px;border-radius:10px"></span>
        </div>
      </div>
      <div class="content-body">
        <canvas id="c"></canvas>
        <div class="stats-bar">
          <div class="st"><b id="singularityCount">0</b><small>singularity</small></div>
          <div class="st"><b id="coreCount">0</b><small>core</small></div>
          <div class="st"><b id="synapseCount">0</b><small>synapses</small></div>
          <div class="st"><b id="docCount">0</b><small>docs</small></div>
          <div class="st"><b id="linkDisplay">0</b><small>links</small></div>
        </div>
        <div id="detail"><button class="x" onclick="closeD()">✕</button><div id="dc"></div></div>
      </div>
    </div>
  </div>
  <div id="tip"></div>
</div>

<!-- Add Memory Modal -->
<div id="memModal" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:none;align-items:center;justify-content:center;z-index:100">
  <div style="width:420px;background:var(--ui-bg-elevated);border:1px solid var(--ui-border-muted);border-radius:var(--radius-xl);padding:24px;box-shadow:var(--shadow-shell)">
    <h2 style="font-size:14px;font-weight:700;color:var(--ui-text-highlighted);margin-bottom:4px">Add Memory</h2>
    <p style="font-size:10px;color:var(--ui-text-dimmed);margin-bottom:16px">Mother will pick this up, connect it to the graph, and redeploy.</p>
    <textarea id="memText" rows="4" placeholder="What do you want to remember?" style="width:100%;padding:10px 12px;background:rgba(255,255,255,0.05);border:1px solid var(--ui-border-muted);border-radius:var(--radius);color:var(--ui-text);font-size:12px;font-family:'Plus Jakarta Sans',sans-serif;outline:none;resize:vertical"></textarea>
    <select id="memTag" style="width:100%;margin-top:8px;padding:8px 12px;background:rgba(255,255,255,0.05);border:1px solid var(--ui-border-muted);border-radius:var(--radius);color:var(--ui-text);font-size:11px;font-family:'Plus Jakarta Sans',sans-serif;outline:none;appearance:none">
      <option value="general">General</option>
      <option value="client">Client</option>
      <option value="strategy">Strategy</option>
      <option value="technical">Technical</option>
      <option value="personal">Personal</option>
      <option value="idea">Idea</option>
    </select>
    <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
      <button onclick="closeMem()" style="padding:8px 16px;border-radius:var(--radius);font-size:11px;font-weight:600;font-family:'Plus Jakarta Sans',sans-serif;cursor:pointer;background:transparent;border:1px solid var(--ui-border-muted);color:var(--ui-text-dimmed)">Cancel</button>
      <button onclick="saveMem()" style="padding:8px 16px;border-radius:var(--radius);font-size:11px;font-weight:600;font-family:'Plus Jakarta Sans',sans-serif;cursor:pointer;background:linear-gradient(-45deg,rgba(86,140,255,0.35),rgba(255,164,120,0.30));border:none;color:var(--ui-text)">Save</button>
    </div>
  </div>
</div>

<script>
// Pending memories system
const MEM_KEY='portal_pending_memories';
function getPending(){return JSON.parse(localStorage.getItem(MEM_KEY)||'[]')}
function setPending(arr){localStorage.setItem(MEM_KEY,JSON.stringify(arr));updateBadge()}
function updateBadge(){const p=getPending();const b=document.getElementById('pendingBadge');if(p.length){b.style.display='inline';b.textContent=p.length+' pending'}else{b.style.display='none'}}
function openMem(){document.getElementById('memModal').style.display='flex';document.getElementById('memText').focus()}
function closeMem(){document.getElementById('memModal').style.display='none';document.getElementById('memText').value=''}
function saveMem(){
  const text=document.getElementById('memText').value.trim();
  if(!text)return;
  const tag=document.getElementById('memTag').value;
  const pending=getPending();
  pending.push({text,tag,created:new Date().toISOString(),id:'m'+Date.now()});
  setPending(pending);closeMem();
}
document.getElementById('memModal').addEventListener('click',e=>{if(e.target.id==='memModal')closeMem()});
document.getElementById('memText').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.metaKey)saveMem()});
updateBadge();
</script>

<script>
document.querySelectorAll('.sb-item[data-page]').forEach(el=>{if(el.dataset.page==='brain')el.classList.add('active')});
const G=${JSON.stringify(data)};
const LABELS=${JSON.stringify(data.nodes.map(n=>getLabel(n)))};
function getCat(n){return n.tags?.[0]||n.category||'general'}
function getCol(n){
  // Calculate max hits across all nodes
  const maxHits = Math.max(...G.nodes.map(node => node.usage?.hits || 0), 1);
  const usageRatio = (n.usage?.hits || 0) / maxHits;
  
  // Color interpolation based on usage
  // Low usage (0): cool blue-gray #4a5568
  // Medium usage: warm amber #c49a50  
  // High usage (1.0): hot orange-red #e8734a
  let r, g, b;
  
  if (usageRatio <= 0.5) {
    // Interpolate from blue-gray to amber
    const t = usageRatio * 2; // 0 to 1
    r = Math.round(74 + (196 - 74) * t);   // 74 -> 196
    g = Math.round(85 + (154 - 85) * t);   // 85 -> 154  
    b = Math.round(104 + (80 - 104) * t);  // 104 -> 80
  } else {
    // Interpolate from amber to orange-red
    const t = (usageRatio - 0.5) * 2; // 0 to 1
    r = Math.round(196 + (232 - 196) * t);  // 196 -> 232
    g = Math.round(154 + (115 - 154) * t);  // 154 -> 115
    b = Math.round(80 + (74 - 80) * t);     // 80 -> 74
  }
  
  // Core nodes get slight brightness boost
  if (n.isCore) {
    r = Math.min(255, r * 1.1);
    g = Math.min(255, g * 1.1); 
    b = Math.min(255, b * 1.1);
  }
  
  // Singularity nodes get full white glow
  if (n.isSingularity) {
    return '#ffffff';
  }
  
  // Doc nodes get teal/cyan color
  if (n.isDoc) {
    return '#2dd4bf';
  }
  
  return '#' + Math.round(r).toString(16).padStart(2,'0') + Math.round(g).toString(16).padStart(2,'0') + Math.round(b).toString(16).padStart(2,'0');
}
function getRad(n) {
  const baseR = 3;
  const usageR = Math.min(4, (n.usage?.hits || 0) * 0.3);
  const coreR = n.isCore ? 2 : 0;
  const singR = n.isSingularity ? 2 : 0;
  return baseR + usageR + coreR + singR;
}

${AUTH_JS}

let ctx,W,H,nodes,edges,mx=0,my=0,hover=null,sel=null,connSet=new Set();
let camX=0,camY=0,camZ=1,dragging=false,dragNode=null,searchQ='';
document.getElementById('si').addEventListener('input',e=>{searchQ=e.target.value.toLowerCase()});

function onAuth(){
  const cv=document.getElementById('c');
  const body=cv.parentElement;
  W=cv.width=body.clientWidth;H=cv.height=body.clientHeight;
  ctx=cv.getContext('2d');
  nodes=G.nodes.map((n,i)=>{
    const a=(i/G.nodes.length)*Math.PI*2,d=120+Math.random()*180;
    return{...n,x:Math.cos(a)*d,y:Math.sin(a)*d,vx:0,vy:0,col:getCol(n),r:getRad(n),label:LABELS[i]};
  });
  const nm=new Map(nodes.map(n=>[n.id,n]));
  const allE=G.edges.map(e=>({s:nm.get(e.source),t:nm.get(e.target),w:e.weight||1,usage:e.usage})).filter(e=>e.s&&e.t);
  allE.sort((a,b)=>b.w-a.w);edges=allE;
  const mxW=Math.max(...edges.map(e=>e.w),1);edges.forEach(e=>e.nw=e.w/mxW);
  
  // Update stats with node tier counts
  const singularityCount = G.nodes.filter(n => n.isSingularity || n.tier === 'singularity').length;
  const coreCount = G.nodes.filter(n => n.isCore || n.tier === 'core' || n.tier === 'singularity').length;
  const synapseCount = G.nodes.filter(n => !n.isCore && n.tier !== 'core' && n.tier !== 'singularity' && n.tier !== 'merged' && n.tier !== 'raptor').length;
  
  const docNodeCount = G.nodes.filter(n => n.isDoc).length;
  document.getElementById('singularityCount').textContent = singularityCount;
  document.getElementById('coreCount').textContent = coreCount;
  document.getElementById('synapseCount').textContent = synapseCount;
  document.getElementById('docCount').textContent = docNodeCount;
  document.getElementById('linkDisplay').textContent = edges.length;
  cv.addEventListener('mousemove',onM);cv.addEventListener('mousedown',onD);
  cv.addEventListener('mouseup',onU);cv.addEventListener('wheel',onW,{passive:false});
  cv.addEventListener('click',onClick);
  requestAnimationFrame(tick);
}
function w2s(x,y){return[(x-camX)*camZ+W/2,(y-camY)*camZ+H/2]}
function s2w(sx,sy){return[(sx-W/2)/camZ+camX,(sy-H/2)/camZ+camY]}
function isF(n){return searchQ&&!(n.text||'').toLowerCase().includes(searchQ)&&!getCat(n).includes(searchQ)}
function onM(e){const r=e.target.getBoundingClientRect();mx=e.clientX-r.left;my=e.clientY-r.top;
  if(dragging&&!dragNode){camX-=e.movementX/camZ;camY-=e.movementY/camZ;return}
  if(dragNode){const[wx,wy]=s2w(mx,my);dragNode.x=wx;dragNode.y=wy;dragNode.vx=0;dragNode.vy=0;return}
  const[wx,wy]=s2w(mx,my);let best=null,bd=Infinity;
  for(const n of nodes){if(isF(n))continue;const d=Math.hypot(n.x-wx,n.y-wy);if(d<n.r+10&&d<bd){bd=d;best=n}}
  if(best!==hover){hover=best;e.target.style.cursor=best?'pointer':'default';
    if(best){const t=document.getElementById('tip');t.textContent=best.label;t.style.left=(e.clientX+12)+'px';t.style.top=(e.clientY-8)+'px';t.classList.add('s')}
    else document.getElementById('tip').classList.remove('s')}
}
function onD(){if(hover)dragNode=hover;else dragging=true}
function onU(){dragNode=null;dragging=false}
function onW(e){e.preventDefault();camZ=Math.max(.2,Math.min(5,camZ*(e.deltaY>0?.92:1.08)))}
function onClick(){if(hover)selectN(hover);else if(!dragNode)closeD()}
function selectN(d){
  sel=d;connSet.clear();
  edges.forEach(e=>{if(e.s.id===d.id)connSet.add(e.t.id);if(e.t.id===d.id)connSet.add(e.s.id)});
  const cn=nodes.filter(n=>connSet.has(n.id));
  const docBadge = d.isDoc ? '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:8px;font-weight:700;background:rgba(45,212,191,0.15);color:#2dd4bf;border:1px solid rgba(45,212,191,0.2);margin-bottom:6px">📄 DOC CHUNK</span><br>' : '';
  document.getElementById('dc').innerHTML=docBadge+'<h2>'+d.label+'</h2><div class="mt">'+(d.text||'').replace(/</g,'&lt;')+'</div><div class="tags">'+(d.tags||[]).map(t=>'<span class="tg">'+t+'</span>').join('')+'</div><div class="meta">'+(d.sourceFile||'')+' · '+connSet.size+' connections</div><h3>Connected</h3>'+cn.slice(0,20).map(n=>'<div class="cn">'+n.label+'</div>').join('');
  document.getElementById('detail').classList.add('open');
}
function closeD(){document.getElementById('detail').classList.remove('open');sel=null;connSet.clear()}
function physics(){
  for(const n of nodes){n.vx-=n.x*.0002;n.vy-=n.y*.0002}
  for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++){
    const a=nodes[i],b=nodes[j];let dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;
    if(d>500)continue;const f=-150/(d*d);dx*=f/d;dy*=f/d;a.vx+=dx;a.vy+=dy;b.vx-=dx;b.vy-=dy}
  for(const e of edges){const dx=e.t.x-e.s.x,dy=e.t.y-e.s.y,d=Math.hypot(dx,dy)||1;
    const f=(d-120)*.0006*e.w;e.s.vx+=dx/d*f;e.s.vy+=dy/d*f;e.t.vx-=dx/d*f;e.t.vy-=dy/d*f}
  for(const n of nodes){if(n===dragNode)continue;n.vx*=.88;n.vy*=.88;n.x+=n.vx;n.y+=n.vy}
}
function tick(){
  requestAnimationFrame(tick);physics();ctx.clearRect(0,0,W,H);
  // Calculate max edge usage hits for color interpolation
  const maxEdgeHits = Math.max(...edges.map(e => e.usage?.hits || 0), 1);
  for(const e of edges){const sf=isF(e.s),tf=isF(e.t);if(sf&&tf)continue;
    const[x1,y1]=w2s(e.s.x,e.s.y),[x2,y2]=w2s(e.t.x,e.t.y);
    let a=.12+e.nw*.18,w=.5+e.nw*2;
    if(sel){const c=(e.s.id===sel.id||e.t.id===sel.id);if(c){a=.4+e.nw*.3;w=1+e.nw*2.5}else a=.03}
    if(sf||tf)a*=.1;
    // Usage-based edge color
    const usageHits = e.usage?.hits || 0;
    const usageRatio = usageHits / maxEdgeHits;
    let r, g, b;
    if (usageRatio <= 0.5) {
      // Low usage: cool blue-gray to amber
      const t = usageRatio * 2;
      r = Math.round(74 + (196 - 74) * t);   // 74 -> 196
      g = Math.round(85 + (154 - 85) * t);   // 85 -> 154  
      b = Math.round(104 + (80 - 104) * t);  // 104 -> 80
    } else {
      // High usage: amber to orange-red
      const t = (usageRatio - 0.5) * 2;
      r = Math.round(196 + (232 - 196) * t);  // 196 -> 232
      g = Math.round(154 + (115 - 154) * t);  // 154 -> 115
      b = Math.round(80 + (74 - 80) * t);     // 80 -> 74
    }
    ctx.strokeStyle='rgba('+r+','+g+','+b+','+a+')';ctx.lineWidth=w*camZ;
    ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke()}
  for(const n of nodes){const[sx,sy]=w2s(n.x,n.y);if(sx<-60||sx>W+60||sy<-60||sy>H+60)continue;
    const r=n.r*camZ;let al=isF(n)?.06:1;if(sel&&n!==sel&&!connSet.has(n.id))al=.08;
    ctx.globalAlpha=al;ctx.fillStyle=n.col;ctx.beginPath();
    if(n.isDoc){ctx.moveTo(sx,sy-r*1.3);ctx.lineTo(sx+r*1.3,sy);ctx.lineTo(sx,sy+r*1.3);ctx.lineTo(sx-r*1.3,sy);ctx.closePath()}
    else{ctx.arc(sx,sy,r,0,Math.PI*2)}
    ctx.fill();
    if(n===hover||n===sel){ctx.strokeStyle=n.isDoc?'rgba(45,212,191,0.35)':'rgba(248,250,252,0.2)';ctx.lineWidth=1;ctx.beginPath();
      if(n.isDoc){const rr=r*1.3+3*camZ;ctx.moveTo(sx,sy-rr);ctx.lineTo(sx+rr,sy);ctx.lineTo(sx,sy+rr);ctx.lineTo(sx-rr,sy);ctx.closePath()}
      else{ctx.arc(sx,sy,r+3*camZ,0,Math.PI*2)}
      ctx.stroke()}
    if(camZ>.5||n.r>5){ctx.fillStyle='rgba(248,250,252,'+(0.45*al)+')';ctx.font=Math.max(9,10*camZ)+'px "Plus Jakarta Sans",sans-serif';ctx.textAlign='center';ctx.fillText(n.label,sx,sy+r+11*camZ)}
    ctx.globalAlpha=1}
  if(hover){const t=document.getElementById('tip');t.style.left=(mx+80)+'px';t.style.top=(my+70)+'px'}
}
window.addEventListener('resize',()=>{const cv=document.getElementById('c'),p=cv.parentElement;W=cv.width=p.clientWidth;H=cv.height=p.clientHeight});
</script>
</body>
</html>`;

// ========== TEAM PAGE ==========
const teamHtml = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
${SHARED_HEAD}
<title>Team — Mother's Portal</title>
<style>
${SHARED_CSS}
body{overflow:auto;display:block;padding:16px}
#appWrap{display:block;height:100%}
.content-body{padding:32px 20px;display:flex;flex-direction:column;align-items:center}
.page-title{font-size:20px;font-weight:700;letter-spacing:-0.02em;color:var(--ui-text-highlighted);margin-bottom:4px}
.page-sub{font-size:11px;color:var(--ui-text-dimmed);text-transform:uppercase;letter-spacing:0.2em;font-weight:600;margin-bottom:40px}
.tree{display:flex;flex-direction:column;align-items:center}
.connector{width:1px;height:28px;background:var(--ui-border-accented)}
.branch-row{display:flex;gap:32px;position:relative}
.branch-item{display:flex;flex-direction:column;align-items:center}
.branch-item .connector{height:14px}
.agent{width:220px;padding:18px;text-align:center;
  background:linear-gradient(180deg,rgba(18,26,38,0.88),rgba(18,26,38,0.68));
  border:1px solid var(--ui-border-muted);border-radius:var(--radius-xl);
  box-shadow:var(--shadow-soft);transition:all .2s}
.agent:hover{border-color:var(--ui-border-accented);transform:translateY(-2px)}
.agent.head{width:260px;border-color:var(--ui-border-accented)}
.agent.you{border-color:rgba(86,140,255,0.2)}
.avatar{width:44px;height:44px;border-radius:50%;margin:0 auto 8px;display:flex;align-items:center;
  justify-content:center;font-size:20px;border:2px solid var(--ui-border-accented)}
.agent.head .avatar{width:52px;height:52px;font-size:24px;border-color:rgba(248,250,252,0.15)}
.agent.you .avatar{border-color:rgba(86,140,255,0.25)}
.agent h2{font-size:13px;font-weight:700;letter-spacing:-0.02em;color:var(--ui-text-highlighted);margin-bottom:2px}
.agent .role{font-size:9px;font-weight:600;color:var(--ui-text-dimmed);text-transform:uppercase;letter-spacing:0.12em;margin-bottom:8px}
.agent .desc{font-size:10px;color:var(--ui-text-muted);line-height:1.5;margin-bottom:10px}
.status{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;font-size:8px;font-weight:600;letter-spacing:0.05em}
.status.online{background:rgba(52,211,153,0.1);color:#34d399}
.status.online::before{content:'';width:5px;height:5px;border-radius:50%;background:#34d399}
.status.vacant{background:rgba(248,250,252,0.03);color:var(--ui-text-dimmed)}
.meta-row{display:flex;justify-content:center;gap:10px;margin-top:8px}
.meta-item{font-size:8px;color:var(--ui-text-dimmed)}.meta-item b{color:var(--ui-text-muted)}
.agent.vacant{border-style:dashed;opacity:0.45}
.agent.vacant .avatar{border-style:dashed}
</style>
</head>
<body>
<div id="loginWrap" style="display:none"></div>
<div id="appWrap">
  <div class="shell">
    ${SIDEBAR_HTML}
    <div class="content">
      <div class="content-header"><h1>Team</h1></div>
      <div class="content-body">
        <div class="page-sub" style="margin-top:8px">Agent Hierarchy</div>
        <div class="tree">
          <div class="agent head"><div class="avatar">👤</div><h2>Vlad</h2><div class="role">Founder · Head</div>
            <div class="desc">Email marketing, AI/vibe-coding, strategy.</div><span class="status online">ONLINE</span></div>
          <div class="connector"></div>
          <div class="agent you"><div class="avatar">🫀</div><h2>Mother</h2><div class="role">Chief AI Guardian</div>
            <div class="desc">Strategy, ops, memory, monitoring. Manages all agents. Claude Opus.</div><span class="status online">ONLINE</span>
            <div class="meta-row"><div class="meta-item"><b>Mac mini</b> host</div><div class="meta-item"><b>24/7</b></div><div class="meta-item"><b>12+</b> crons</div></div></div>
          <div class="connector"></div>
          <div class="branch-row">
            <div style="position:absolute;top:0;left:0;right:0;height:1px;background:var(--ui-border-accented)"></div>
            <div class="branch-item"><div class="connector"></div>
              <div class="agent"><div class="avatar">⚡</div><h2>Sola</h2><div class="role">Email Builder</div>
                <div class="desc">Builds emails, compiles sections. GPT-5.3 Codex.</div><span class="status online">ONLINE</span>
                <div class="meta-row"><div class="meta-item"><b>Mac mini #2</b></div><div class="meta-item"><b>LAN</b></div></div></div></div>
            <div class="branch-item"><div class="connector"></div>
              <div class="agent"><div class="avatar">🎯</div><h2>Hunter</h2><div class="role">Sales Agent</div>
                <div class="desc">Upwork scouting, proposals, freelancer outreach. Claude Sonnet.</div><span class="status online">ONLINE</span>
                <div class="meta-row"><div class="meta-item"><b>Mac mini #1</b></div><div class="meta-item"><b>Multi-agent</b></div></div></div></div>
            <div class="branch-item"><div class="connector"></div>
              <div class="agent vacant"><div class="avatar">+</div><h2>Open</h2><div class="role">TBD</div>
                <div class="desc">Next agent slot.</div><span class="status vacant">VACANT</span></div></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
document.querySelectorAll('.sb-item[data-page]').forEach(el=>{if(el.dataset.page==='team')el.classList.add('active')});
if(localStorage.getItem('portal_auth')!=='1')window.location.href='core.html';
</script>
</body>
</html>`;

// ========== TODO PAGE ==========
const todoCats = [...new Set(todos.map(t=>t.category))];
const todoHtml = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
${SHARED_HEAD}
<title>Todo — Mother's Portal</title>
<style>
${SHARED_CSS}
body{overflow:auto;display:block;padding:16px}
#appWrap{display:block;height:100%}
.content-body{padding:20px;overflow-y:auto}

.todo-controls{display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap}
.filter-btn{padding:4px 12px;border-radius:20px;font-size:10px;font-weight:600;
  background:rgba(255,255,255,0.03);border:1px solid var(--ui-border-muted);
  color:var(--ui-text-dimmed);cursor:pointer;transition:all .15s;font-family:'Plus Jakarta Sans',sans-serif}
.filter-btn:hover{background:rgba(255,255,255,0.06);color:var(--ui-text)}
.filter-btn.active{background:rgba(86,140,255,0.12);border-color:rgba(86,140,255,0.25);color:var(--ui-text)}
.add-btn{margin-left:auto;padding:6px 14px;border-radius:var(--radius);font-size:10px;font-weight:600;
  background:linear-gradient(-45deg,rgba(86,140,255,0.30),rgba(255,164,120,0.25));
  border:1px solid rgba(86,140,255,0.15);color:var(--ui-text);cursor:pointer;
  font-family:'Plus Jakarta Sans',sans-serif;transition:all .15s}
.add-btn:hover{border-color:rgba(86,140,255,0.3)}

.todo-section{margin-bottom:24px}
.section-label{font-size:9px;font-weight:600;color:var(--ui-text-dimmed);text-transform:uppercase;
  letter-spacing:0.15em;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.section-label .count{background:rgba(255,255,255,0.05);padding:1px 6px;border-radius:10px;font-variant-numeric:tabular-nums}

.todo-item{display:flex;align-items:flex-start;gap:10px;padding:10px 14px;
  background:rgba(255,255,255,0.02);border:1px solid var(--ui-border-muted);
  border-radius:var(--radius);margin-bottom:4px;transition:all .15s;cursor:default}
.todo-item:hover{background:rgba(255,255,255,0.04);border-color:var(--ui-border-accented)}
.todo-item.done{opacity:0.35}
.todo-item.done .todo-text{text-decoration:line-through}

.todo-check{width:16px;height:16px;border-radius:4px;border:1.5px solid var(--ui-border-accented);
  flex-shrink:0;cursor:pointer;display:flex;align-items:center;justify-content:center;
  margin-top:1px;transition:all .15s;background:transparent}
.todo-check:hover{border-color:rgba(86,140,255,0.4)}
.todo-check.checked{background:rgba(52,211,153,0.15);border-color:rgba(52,211,153,0.4)}
.todo-check.checked::after{content:'✓';font-size:10px;color:#34d399;font-weight:700}

.todo-body{flex:1;min-width:0}
.todo-text{font-size:12px;color:var(--ui-text);line-height:1.5}
.todo-meta{display:flex;gap:8px;margin-top:3px;align-items:center}
.todo-tag{font-size:8px;font-weight:600;padding:1px 6px;border-radius:var(--radius);
  background:rgba(255,255,255,0.04);border:1px solid var(--ui-border-muted);color:var(--ui-text-dimmed)}
.todo-date{font-size:9px;color:var(--ui-text-dimmed)}
.todo-priority{font-size:8px;font-weight:700;padding:1px 6px;border-radius:var(--radius)}
.todo-priority.high{background:rgba(239,68,68,0.1);color:#ef4444}
.todo-priority.medium{background:rgba(234,179,8,0.1);color:#eab308}
.todo-priority.low{background:rgba(100,116,139,0.1);color:#64748b}

.todo-del{opacity:0;margin-left:auto;padding:2px 6px;border-radius:var(--radius);font-size:10px;
  color:var(--ui-text-dimmed);cursor:pointer;background:transparent;border:none;
  font-family:'Plus Jakarta Sans',sans-serif;transition:all .15s}
.todo-item:hover .todo-del{opacity:0.5}
.todo-del:hover{opacity:1!important;color:#ef4444}

.empty-state{text-align:center;padding:60px 20px;color:var(--ui-text-dimmed)}
.empty-state .icon{font-size:32px;margin-bottom:12px;opacity:0.3}
.empty-state p{font-size:11px}

/* Add modal */
.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);
  display:none;align-items:center;justify-content:center;z-index:100}
.modal-overlay.open{display:flex}
.modal{width:380px;background:var(--ui-bg-elevated);border:1px solid var(--ui-border-muted);
  border-radius:var(--radius-xl);padding:24px;box-shadow:var(--shadow-shell)}
.modal h2{font-size:14px;font-weight:700;color:var(--ui-text-highlighted);margin-bottom:16px}
.modal label{font-size:10px;font-weight:600;color:var(--ui-text-dimmed);text-transform:uppercase;
  letter-spacing:0.1em;display:block;margin-bottom:4px;margin-top:12px}
.modal input,.modal select,.modal textarea{width:100%;padding:8px 12px;background:rgba(255,255,255,0.05);
  border:1px solid var(--ui-border-muted);border-radius:var(--radius);color:var(--ui-text);
  font-size:12px;font-family:'Plus Jakarta Sans',sans-serif;outline:none}
.modal textarea{resize:vertical;min-height:60px}
.modal input:focus,.modal select:focus,.modal textarea:focus{border-color:rgba(59,130,246,0.25)}
.modal select{appearance:none;cursor:pointer}
.modal-actions{display:flex;gap:8px;margin-top:20px;justify-content:flex-end}
.modal-actions button{padding:8px 16px;border-radius:var(--radius);font-size:11px;font-weight:600;
  font-family:'Plus Jakarta Sans',sans-serif;cursor:pointer;transition:all .15s}
.btn-cancel{background:transparent;border:1px solid var(--ui-border-muted);color:var(--ui-text-dimmed)}
.btn-cancel:hover{color:var(--ui-text)}
.btn-save{background:linear-gradient(-45deg,rgba(86,140,255,0.35),rgba(255,164,120,0.30));
  border:none;color:var(--ui-text)}

.stats-row{display:flex;gap:16px;margin-bottom:20px}
.stat-card{padding:12px 16px;background:rgba(255,255,255,0.02);border:1px solid var(--ui-border-muted);
  border-radius:var(--radius-xl);flex:1;min-width:0}
.stat-card b{font-size:20px;font-weight:800;color:var(--ui-text-highlighted);display:block;
  font-variant-numeric:tabular-nums;letter-spacing:-0.02em}
.stat-card small{font-size:8px;text-transform:uppercase;letter-spacing:0.15em;font-weight:600;color:var(--ui-text-dimmed)}
</style>
</head>
<body>
<div id="loginWrap" style="display:none"></div>
<div id="appWrap">
  <div class="shell">
    ${SIDEBAR_HTML}
    <div class="content">
      <div class="content-header">
        <h1>Todo</h1>
        <div style="font-size:10px;color:var(--ui-text-dimmed)">Last sync: ${new Date().toISOString().slice(0,16).replace('T',' ')}</div>
      </div>
      <div class="content-body">
        <div class="stats-row" id="statsRow"></div>
        <div class="todo-controls" id="controls"></div>
        <div id="todoList"></div>
      </div>
    </div>
  </div>
</div>

<!-- Add Task Modal -->
<div class="modal-overlay" id="addModal">
  <div class="modal">
    <h2>New Task</h2>
    <label>Task</label>
    <input type="text" id="newText" placeholder="What needs doing?">
    <label>Category</label>
    <input type="text" id="newCat" placeholder="e.g. clients, ecomhero, infra">
    <label>Priority</label>
    <select id="newPri"><option value="high">High</option><option value="medium" selected>Medium</option><option value="low">Low</option></select>
    <label>Due date (optional)</label>
    <input type="date" id="newDue">
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-save" onclick="addTask()">Add Task</button>
    </div>
  </div>
</div>

<script>
document.querySelectorAll('.sb-item[data-page]').forEach(el=>{if(el.dataset.page==='todo')el.classList.add('active')});
if(localStorage.getItem('portal_auth')!=='1')window.location.href='core.html';

// Merge embedded todos with localStorage overrides
const EMBEDDED = ${JSON.stringify(todos)};
const LS_KEY = 'portal_todos';

function loadTodos(){
  const stored = JSON.parse(localStorage.getItem(LS_KEY)||'null');
  if(!stored) return EMBEDDED.map(t=>({...t}));
  // Merge: embedded is source of truth for new tasks, localStorage for state
  const storedMap = new Map(stored.map(t=>[t.id,t]));
  const merged = [];
  const seen = new Set();
  // Keep all embedded, overlay stored state
  for(const t of EMBEDDED){
    seen.add(t.id);
    const s = storedMap.get(t.id);
    merged.push(s ? {...t,...s} : {...t});
  }
  // Keep locally-added tasks
  for(const t of stored){
    if(!seen.has(t.id)) merged.push(t);
  }
  return merged;
}
function saveTodos(list){ localStorage.setItem(LS_KEY, JSON.stringify(list)); }

let todos = loadTodos();
let filter = 'all';

function render(){
  const active = todos.filter(t=>!t.done);
  const done = todos.filter(t=>t.done);
  const cats = [...new Set(todos.map(t=>t.category))];

  // Stats
  document.getElementById('statsRow').innerHTML = \`
    <div class="stat-card"><b>\${active.length}</b><small>Active</small></div>
    <div class="stat-card"><b>\${done.length}</b><small>Done</small></div>
    <div class="stat-card"><b>\${todos.filter(t=>t.priority==='high'&&!t.done).length}</b><small>High Priority</small></div>
    <div class="stat-card"><b>\${cats.length}</b><small>Categories</small></div>\`;

  // Controls
  document.getElementById('controls').innerHTML = 
    '<button class="filter-btn ' + (filter==='all'?'active':'') + '" onclick="setFilter(\'all\')">All</button>' +
    cats.map(c => '<button class="filter-btn ' + (filter===c?'active':'') + '" onclick="setFilter(\'' + c + '\')">' + c + '</button>').join('') +
    '<button class="add-btn" onclick="openModal()">+ Add Task</button>';

  const filtered = todos.filter(t=> filter==='all' || t.category===filter);
  const fActive = filtered.filter(t=>!t.done);
  const fDone = filtered.filter(t=>t.done);

  let html = '';
  if(fActive.length){
    html += '<div class="todo-section"><div class="section-label">Active <span class="count">' + fActive.length + '</span></div>';
    html += fActive.map(t=>renderItem(t)).join('');
    html += '</div>';
  }
  if(fDone.length){
    html += '<div class="todo-section"><div class="section-label">Completed <span class="count">' + fDone.length + '</span></div>';
    html += fDone.map(t=>renderItem(t)).join('');
    html += '</div>';
  }
  if(!filtered.length){
    html = '<div class="empty-state"><div class="icon">✓</div><p>No tasks. You\\'re all clear.</p></div>';
  }
  document.getElementById('todoList').innerHTML = html;
}

function renderItem(t){
  return '<div class="todo-item ' + (t.done?'done':'') + '">' +
    '<div class="todo-check ' + (t.done?'checked':'') + '" onclick="toggle(\'' + t.id + '\')"></div>' +
    '<div class="todo-body">' +
      '<div class="todo-text">' + esc(t.text) + '</div>' +
      '<div class="todo-meta">' +
        '<span class="todo-tag">' + t.category + '</span>' +
        '<span class="todo-priority ' + t.priority + '">' + t.priority + '</span>' +
        (t.due ? '<span class="todo-date">Due ' + t.due + '</span>' : '') +
        '<span class="todo-date">' + t.created + '</span>' +
      '</div>' +
    '</div>' +
    '<button class="todo-del" onclick="del(\'' + t.id + '\')">✕</button>' +
  '</div>';
}

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function setFilter(f){filter=f;render()}
function toggle(id){const t=todos.find(x=>x.id===id);if(t){t.done=!t.done;saveTodos(todos);render()}}
function del(id){todos=todos.filter(x=>x.id!==id);saveTodos(todos);render()}

function openModal(){document.getElementById('addModal').classList.add('open');document.getElementById('newText').focus()}
function closeModal(){document.getElementById('addModal').classList.remove('open');
  document.getElementById('newText').value='';document.getElementById('newCat').value='';document.getElementById('newDue').value=''}
function addTask(){
  const text=document.getElementById('newText').value.trim();
  if(!text)return;
  todos.push({id:'t'+Date.now(),text,category:document.getElementById('newCat').value.trim()||'general',
    priority:document.getElementById('newPri').value,created:new Date().toISOString().slice(0,10),
    due:document.getElementById('newDue').value||null,done:false});
  saveTodos(todos);closeModal();render();
}
document.getElementById('addModal').addEventListener('click',e=>{if(e.target===document.getElementById('addModal'))closeModal()});
document.getElementById('newText').addEventListener('keydown',e=>{if(e.key==='Enter')addTask()});

render();
</script>
</body>
</html>`;

// ========== CORE PAGE ==========
// With unified-constellation.json, all data is already in 'data' variable

const catColors = {
  identity: '#c47a9a',
  client: '#5ab590',
  strategy: '#c49a50',
  infrastructure: '#5a8ac0',
  relationship: '#8a7ab5',
  lesson: '#c08050'
};

// Build graph data: ALL nodes
const nodeIds = new Set(data.nodes.map(n => n.id));
const graphNodes = data.nodes.map(node => ({
  id: node.id,
  text: node.distilled || node.text || node.id,
  category: node.category || 'general',
  isCore: node.isCore || false,
  isSingularity: node.isSingularity || false,
  label: getLabel(node),
  usageHits: node.usage?.hits || 0,
  sourceFile: node.sourceFile || '',
  tier: node.tier || 'synapse'
}));

// All edges (dedup)
const edgeSet = new Set();
const graphEdges = [];
for (const edge of data.edges) {
  if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
  if (edge.source === edge.target) continue;
  const ek = [edge.source, edge.target].sort().join('|');
  if (edgeSet.has(ek)) continue;
  edgeSet.add(ek);
  graphEdges.push({
    source: edge.source,
    target: edge.target,
    weight: edge.weight || 0.5,
    coreEdge: false,
    usageHits: edge.usage?.hits || 0
  });
}

const filteredNodes = graphNodes;
const filteredNodeIds = nodeIds;
const filteredEdges = graphEdges.filter(e => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target));

const coreGraphData = { nodes: filteredNodes, edges: filteredEdges };

// Core page: use template file with placeholder replacement
const coreTemplate = fs.readFileSync(path.join(__dirname, 'core-graph-template.html'), 'utf8');
const coreHtml = coreTemplate
  .replace('%%SHARED_HEAD%%', SHARED_HEAD)
  .replace('%%SHARED_CSS%%', SHARED_CSS)
  .replace('%%SIDEBAR_HTML%%', SIDEBAR_HTML)
  .replace('%%AUTH_JS%%', AUTH_JS)
  .replace('%%LAST_UPDATED%%', 'Last updated: ' + new Date(data.lastUpdated).toISOString().slice(0,16).replace('T',' '))
  .replace('%%CORE_COUNT%%', String(data.nodes.filter(n => n.isCore).length))
  .replace('%%GRAPH_DATA%%', () => JSON.stringify(coreGraphData))
  .replace('%%CAT_COLORS%%', JSON.stringify(catColors));

const _oldCoreHtml = "removed";

const outDir = __dirname;
const webDir = outDir + '/brain-web';
fs.mkdirSync(webDir, {recursive:true});
const brainRedirect = '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=core.html"><script>window.location.href="core.html"</script></head><body>Redirecting...</body></html>';
fs.writeFileSync(outDir+'/brain.html', brainRedirect);
fs.writeFileSync(outDir+'/team.html', teamHtml);
fs.writeFileSync(outDir+'/core.html', coreHtml);
fs.writeFileSync(webDir+'/index.html', coreHtml);
fs.writeFileSync(webDir+'/brain.html', brainRedirect);
fs.writeFileSync(webDir+'/team.html', teamHtml);
fs.writeFileSync(webDir+'/core.html', coreHtml);
fs.writeFileSync(outDir+'/todo.html', todoHtml);
fs.writeFileSync(webDir+'/todo.html', todoHtml);
// Build monitor page
try {
  require('./brain-web/build-monitor.js');
  const monitorSrc = path.join(__dirname, 'brain-web', 'monitor.html');
  if (fs.existsSync(monitorSrc)) {
    const monitorHtml = fs.readFileSync(monitorSrc, 'utf8');
    fs.writeFileSync(outDir+'/monitor.html', monitorHtml);
    fs.writeFileSync(webDir+'/monitor.html', monitorHtml);
    console.log('Monitor page built');
  }
} catch(e) { console.log('Monitor build skipped:', e.message); }

console.log('Portal built with shell layout (core, team, todo, monitor)');

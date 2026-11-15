// /spawn 页面：玩家在浏览器里亲自组队 / 派子代理。
// 团队成员 textarea 每行「名字 | 角色 | 任务 | 文件1,文件2」，浏览器端拆成 members 数组。
export function spawnHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AuroraTui · 手动开工</title>
<style>
:root{--bg:#0b0e14;--panel:#111722;--panel2:#0e1420;--line:#1e2637;--text:#d7dde8;--dim:#8b98ad;--faint:#5a657a;--accent:#6cb6ff;--ok:#5fd38d;--bad:#ff7a85;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.6 var(--mono)}
header{display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid var(--line);background:var(--panel2)}
header b{font-size:14px;letter-spacing:.5px}header .grow{flex:1}
header a{color:var(--dim);text-decoration:none;border:1px solid var(--line);border-radius:6px;padding:4px 10px}
header a:hover{color:var(--accent);border-color:var(--accent)}
main{max-width:920px;margin:0 auto;padding:20px 18px 60px}
.card{border:1px solid var(--line);border-radius:10px;background:var(--panel2);padding:16px 18px;margin-bottom:14px}
h2{font-size:13px;margin:0 0 10px;color:var(--accent);letter-spacing:.5px;font-weight:600}
label{display:block;color:var(--dim);font-size:12px;margin:10px 0 4px}
input,textarea,select{width:100%;background:#0a0f18;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:8px 10px;font:12px/1.5 var(--mono);outline:none}
input:focus,textarea:focus,select:focus{border-color:var(--accent)}
textarea{resize:vertical;min-height:84px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:700px){.row{grid-template-columns:1fr}}
.hint{color:var(--faint);font-size:11px;margin-top:5px}
button{background:var(--accent);color:#06121f;border:0;border-radius:7px;padding:9px 18px;font:600 12px var(--mono);cursor:pointer}
button:disabled{opacity:.5;cursor:default}
.msg{margin-top:12px;padding:10px 12px;border-radius:7px;border:1px solid var(--line);background:var(--panel);display:none;white-space:pre-wrap}
.msg.ok{border-color:#245c3c;color:var(--ok)}
.msg.err{border-color:#5c2430;color:var(--bad)}
.msg a{color:var(--accent)}
</style></head><body>
<header><b>AuroraTui · 手动开工</b><span class="grow"></span><a href="/">团队面板</a><a href="/shell">Shell 任务</a></header>
<main>
  <div class="card">
    <h2>要做什么</h2>
    <label for="kind">开工方式</label>
    <select id="kind">
      <option value="team">组一支团队（多成员并行）</option>
      <option value="solo">派一个子代理（单线跑）</option>
    </select>
    <div class="hint">玩家亲自下的活，不受 settings.team / settings.subagents 开关限制。成员跑在后台，关掉页面也不会停；终端按 ESC 或 team stop 才会中断。</div>
  </div>

  <div id="teamBox" class="card">
    <h2>团队</h2>
    <div class="row">
      <div><label for="tname">团队名</label><input id="tname" placeholder="比如：登录页重构" value="浏览器小队"></div>
      <div><label for="conc">并发人数</label><input id="conc" type="number" min="1" max="8" value="2"></div>
    </div>
    <label for="goal">总目标</label>
    <textarea id="goal" placeholder="一句话说清这支团队要交付什么，成员都会看到。"></textarea>
    <label for="members">成员（每行一个：名字 | 角色 | 任务 | 相关文件，文件可省略）</label>
    <textarea id="members" style="min-height:150px" placeholder="阿岩 | 后端 | 实现 /api/login 并补测试 | src/api/login.js, test/login-test.js
小满 | 前端 | 接登录表单、错误提示与跳转 | src/ui/login.js
阿岚 | 审查 | 独立复核改动，找边界问题"></textarea>
    <div class="hint">任务里可以再写 |，服务端会把第 3 段之后的内容当成任务。至少 1 个成员。</div>
    <div style="margin-top:14px"><button id="goTeam">开工</button></div>
  </div>

  <div id="soloBox" class="card" style="display:none">
    <h2>子代理</h2>
    <div class="row">
      <div><label for="sname">名字</label><input id="sname" placeholder="子代理"></div>
      <div><label for="srole">角色</label><input id="srole" placeholder="比如：审查 / 后端 / 测试"></div>
    </div>
    <label for="stask">任务</label>
    <textarea id="stask" placeholder="写清楚交付物、约束和验收标准。"></textarea>
    <div class="row">
      <div><label for="stools">工具（逗号分隔，留空=默认）</label><input id="stools" placeholder="read, write, shell, grep"></div>
      <div><label for="smodel">模型（留空=继承）</label><input id="smodel" placeholder="provider/model"></div>
    </div>
    <div class="row">
      <div><label for="ssteps">最多步数</label><input id="ssteps" type="number" min="1" max="200" value="40"></div>
      <div><label for="stimeout">超时（秒）</label><input id="stimeout" type="number" min="30" max="3600" value="600"></div>
    </div>
    <div style="margin-top:14px"><button id="goSolo">开工</button></div>
  </div>

  <div id="msg" class="msg"></div>
</main>
<script>
function $(id){return document.getElementById(id)}
function show(ok,text,url){
  var m=$('msg');m.className='msg '+(ok?'ok':'err');
  m.innerHTML='';
  m.appendChild(document.createTextNode(text));
  if(url){var a=document.createElement('a');a.href=url;a.target='_blank';a.textContent=' 打开面板 ↗';m.appendChild(a)}
  m.style.display='block';
}
function parseMembers(text){
  return String(text||'').split(/\r?\n/).map(function(s){return s.trim()}).filter(function(s){return s&&s.charAt(0)!=='#'}).map(function(line,i){
    var p=line.split('|').map(function(s){return s.trim()});
    var files=[];
    if(p.length>=4){files=p.pop().split(/[,，\s]+/).filter(Boolean)}
    return {name:p[0]||('成员'+(i+1)),role:p[1]||'开发',task:p.slice(2).join(' | ').trim(),files:files};
  }).filter(function(m){return m.task});
}
function post(payload,btn){
  btn.disabled=true;var old=btn.textContent;btn.textContent='开工中…';
  show(true,'正在交给后台…','');
  fetch('/api/spawn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
    .then(function(r){return r.json()}).then(function(d){
      show(!!d.ok,d.content||'(没有返回内容)',d.url);
    }).catch(function(e){show(false,'请求失败：'+e)})
    .then(function(){btn.disabled=false;btn.textContent=old});
}
$('kind').onchange=function(){
  var team=$('kind').value==='team';
  $('teamBox').style.display=team?'block':'none';
  $('soloBox').style.display=team?'none':'block';
  $('msg').style.display='none';
};
$('goTeam').onclick=function(){
  var members=parseMembers($('members').value);
  if(!$('goal').value.trim())return show(false,'先写总目标。');
  if(!members.length)return show(false,'至少写一个成员，格式：名字 | 角色 | 任务 | 文件');
  post({kind:'team',name:$('tname').value.trim(),goal:$('goal').value.trim(),concurrency:Number($('conc').value)||2,members:members},$('goTeam'));
};
$('goSolo').onclick=function(){
  if(!$('stask').value.trim())return show(false,'先写任务。');
  post({kind:'solo',name:$('sname').value.trim(),role:$('srole').value.trim(),task:$('stask').value.trim(),tools:$('stools').value.trim(),model:$('smodel').value.trim(),maxSteps:Number($('ssteps').value)||40,timeoutSec:Number($('stimeout').value)||600},$('goSolo'));
};
</script>
</body></html>`;
}

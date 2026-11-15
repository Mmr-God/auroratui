// /shell 页面（内嵌 HTML/CSS/JS，零外部资源）。
// 数据全部来自 /api/shell：1.2s 轮询列表，选中任务再看详情（含完整输出）。
export function shellHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AuroraTui · Shell 任务</title>
<style>
:root{--bg:#0b0e14;--panel:#111722;--panel2:#0e1420;--line:#1e2637;--text:#d7dde8;--dim:#8b98ad;--faint:#5a657a;--accent:#6cb6ff;--ok:#5fd38d;--warn:#f0b95c;--bad:#ff7a85;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:13px/1.55 var(--mono)}
header{display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid var(--line);background:var(--panel2);position:sticky;top:0;z-index:2}
header b{font-size:14px;letter-spacing:.5px}
header .grow{flex:1}
header a{color:var(--dim);text-decoration:none;border:1px solid var(--line);border-radius:6px;padding:4px 10px}
header a:hover{color:var(--accent);border-color:var(--accent)}
main{padding:14px 18px 30px}
.bar{display:flex;align-items:center;gap:10px;margin-bottom:10px;color:var(--dim);font-size:12px}
.bar .grow{flex:1}
button{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:5px 11px;font:12px var(--mono);cursor:pointer}
button:hover{border-color:var(--accent);color:var(--accent)}
button.danger:hover{border-color:var(--bad);color:var(--bad)}
.split{display:grid;grid-template-columns:minmax(340px,44%) 1fr;gap:12px;align-items:start}
@media(max-width:900px){.split{grid-template-columns:1fr}}
.list{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--panel2);max-height:calc(100vh - 140px);overflow-y:auto}
.job{padding:8px 11px;border-bottom:1px solid var(--line);cursor:pointer;display:grid;grid-template-columns:10px 1fr auto;gap:8px;align-items:start}
.job:last-child{border-bottom:0}
.job:hover{background:#162030}
.job.sel{background:#182436;box-shadow:inset 2px 0 0 var(--accent)}
.dot{width:7px;height:7px;border-radius:50%;margin-top:6px;background:var(--faint)}
.dot.running{background:var(--warn);animation:pulse 1.2s infinite}
.dot.ok{background:var(--ok)}
.dot.error,.dot.killed,.dot.timeout{background:var(--bad)}
@keyframes pulse{50%{opacity:.35}}
.cmd{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
.meta{color:var(--faint);font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.right{color:var(--faint);font-size:11px;text-align:right;white-space:nowrap}
.detail{border:1px solid var(--line);border-radius:8px;background:var(--panel2);min-height:200px;max-height:calc(100vh - 140px);display:flex;flex-direction:column;overflow:hidden}
.dhead{padding:10px 12px;border-bottom:1px solid var(--line);background:var(--panel)}
.dhead .line1{display:flex;gap:10px;align-items:center}
.dhead .line1 b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dhead .grow{flex:1}
.dhead pre{margin:6px 0 0;color:var(--dim);font-size:11px;white-space:pre-wrap;word-break:break-all}
pre.out{margin:0;padding:12px;overflow:auto;flex:1;white-space:pre-wrap;word-break:break-all;color:#c8d3e4;background:#0a0f18;font-size:12px;line-height:1.5}
.empty{padding:40px 16px;text-align:center;color:var(--faint)}
</style></head><body>
<header><b>AuroraTui · Shell</b><span class="grow"></span><a href="/">团队面板</a><a href="/spawn">手动开工</a></header>
<main>
  <div class="bar"><span id="stat">加载中…</span><span class="grow"></span><button id="toggle">暂停刷新</button><button class="danger" id="clear">清空历史</button></div>
  <div class="split">
    <div class="list" id="list"><div class="empty">还没有命令记录</div></div>
    <div class="detail" id="detail"><div class="empty">左边点一个任务，这里看它的完整输出</div></div>
  </div>
</main>
<script>
var LIST=[],SEL=null,DETAIL=null,TIMER=null,LIVE=true,LASTKEY='';
function $(id){return document.getElementById(id)}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function dur(ms){if(ms==null||ms<0||!ms)return '-';if(ms<1000)return Math.round(ms)+'ms';var s=ms/1000;if(s<60)return s.toFixed(1)+'s';return Math.floor(s/60)+'m'+Math.round(s%60)+'s'}
function when(t){if(!t)return '';var d=new Date(t);var p=function(n){return n<10?'0'+n:''+n};return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())}
function statusText(j){if(j.status==='running')return '跑着';if(j.status==='timeout')return '超时';if(j.status==='killed')return '已终止';if(j.status==='ok')return '完成';return '失败'+(j.code==null?'':' ('+j.code+')')}
function drawList(run){
  var el=$('list');
  $('stat').textContent='共 '+LIST.length+' 条 · 运行中 '+run+' · 每 1.2s 刷新';
  if(!LIST.length){el.innerHTML='<div class="empty">还没有命令记录</div>';return}
  el.innerHTML=LIST.map(function(j){
    return '<div class="job'+(SEL===j.id?' sel':'')+'" data-id="'+esc(j.id)+'">'+
      '<span class="dot '+esc(j.status)+'"></span>'+
      '<div><div class="cmd">'+esc(j.preview||j.command)+'</div>'+
      '<div class="meta">'+esc(j.id)+' · '+esc(j.source||'')+' · '+esc(j.cwd||'')+' · '+when(j.started)+'</div></div>'+
      '<div class="right">'+statusText(j)+'<br>'+dur(j.dur)+'<br>'+(j.bytes?(j.bytes>1024?(j.bytes/1024).toFixed(1)+'KB':j.bytes+'B'):'')+'</div></div>';
  }).join('');
}
function drawDetail(){
  var el=$('detail'),j=DETAIL;
  if(!j){el.innerHTML='<div class="empty">左边点一个任务，这里看它的完整输出</div>';return}
  var out=j.output||'（还没有输出）';
  var old=el.querySelector('pre.out');
  var atBottom=!old||(old.scrollTop+old.clientHeight>=old.scrollHeight-30);
  var key=j.id+'|'+j.status+'|'+j.bytes+'|'+out.length;
  if(key===LASTKEY&&old){return}
  var head='<div class="dhead"><div class="line1"><span class="dot '+esc(j.status)+'"></span><b>'+esc(j.command)+'</b><span class="grow"></span>'+
    (j.status==='running'?'<button id="kill" class="danger">终止</button>':'')+'</div>'+
    '<pre>'+esc(j.id)+' · '+esc(j.source||'')+' · '+esc(j.cwd||'')+' · '+statusText(j)+' · '+dur(j.dur)+' · '+esc(j.bytes||0)+' bytes'+(j.truncated?' · 输出已截断':'')+'</pre></div>';
  el.innerHTML=head+'<pre class="out">'+esc(out)+'</pre>';
  LASTKEY=key;
  var pre=el.querySelector('pre.out');
  if(atBottom)pre.scrollTop=pre.scrollHeight;
  var k=$('kill');
  if(k)k.onclick=function(){kill(j.id)};
}
function loadList(){
  return fetch('/api/shell').then(function(r){return r.json()}).then(function(d){
    LIST=d.jobs||[];drawList(d.running||0);
  }).catch(function(){$('stat').textContent='后端断了？刷新页面试试'});
}
function loadDetail(){
  if(!SEL)return Promise.resolve();
  return fetch('/api/shell?id='+encodeURIComponent(SEL)).then(function(r){return r.json()}).then(function(d){
    if(d.job){DETAIL=d.job;drawDetail()}
  }).catch(function(){});
}
function tick(){if(!LIVE)return;loadList();loadDetail()}
function kill(id){
  if(!confirm('终止这个命令？子进程会被 kill。'))return;
  fetch('/api/shell/kill',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})}).then(function(){setTimeout(tick,150)});
}
$('list').addEventListener('click',function(ev){
  var row=ev.target.closest('.job');if(!row)return;
  SEL=row.getAttribute('data-id');LASTKEY='';DETAIL=null;loadList();loadDetail();
});
$('toggle').onclick=function(){LIVE=!LIVE;$('toggle').textContent=LIVE?'暂停刷新':'继续刷新';if(LIVE)tick()};
$('clear').onclick=function(){
  if(!confirm('清空已结束的命令记录？（运行中的会保留）'))return;
  fetch('/api/shell/clear',{method:'POST'}).then(function(){SEL=null;DETAIL=null;LASTKEY='';drawDetail();tick()});
};
loadList().then(function(){if(LIST.length){SEL=LIST[0].id;loadList();loadDetail()}});
TIMER=setInterval(tick,1200);
</script>
</body></html>`;
}

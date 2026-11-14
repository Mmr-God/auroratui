// 语法高亮 + Markdown 渲染测试（零依赖，不需要网络）
import { highlightLines, highlightToAnsi, normalizeLang, supportedLangs, isSupported } from '../src/ui/highlight.js';
import { renderMarkdown } from '../src/ui/markdown.js';
import { stripAnsi, strWidth } from '../src/util.js';

const NL = String.fromCharCode(10);
let failed = 0;
const log = (m = '') => process.stdout.write(m + NL);
function check(name, cond, extra = '') {
  if (!cond) failed++;
  log(`${cond ? '√' : '×'} ${name}${extra ? ` — ${extra}` : ''}`);
}

const KEY = '\x1b[1m\x1b[38;5;141m'; // 关键字色
const STR = '\x1b[38;5;114m'; // 字符串色
const COM = '\x1b[3m\x1b[38;5;240m'; // 注释色
const NUM = '\x1b[38;5;180m'; // 数字色

// ---------------------------------------------------------------- 语言识别
check('normalizeLang: js 别名', normalizeLang('JavaScript') === 'js', normalizeLang('JavaScript'));
check('normalizeLang: mjs → js', normalizeLang('mjs') === 'js');
check('normalizeLang: py → python', normalizeLang('py') === 'python');
check('normalizeLang: sh → bash', normalizeLang('Shell') === 'bash');
check('normalizeLang: yml → yaml', normalizeLang('yml') === 'yaml');
check('normalizeLang: language- 前缀', normalizeLang('language-rust') === 'rust');
check('normalizeLang: 未知语言为空', normalizeLang('brainfuck') === '');
check('isSupported: ts 支持', isSupported('ts') && !isSupported('nope'));
check('supportedLangs 有 20+ 语言', supportedLangs().length >= 20, String(supportedLangs().length));

// ---------------------------------------------------------------- JS
const js = highlightLines(
  [
    'const x = 42; // 注释',
    'function add(a, b) {',
    "  return a + b + 'str';",
    '}',
    '/* 多行',
    '   注释 */',
    'console.log(`hi ${x}`);',
  ],
  'js',
);
check('js 关键字着色', js[0].includes(KEY + 'const'), js[0].slice(0, 40));
check('js 注释着色', js[0].includes(COM), '');
check('js 行注释中文保留', stripAnsi(js[0]).includes('// 注释'));
check('js 函数名着色', /\x1b\[38;5;117madd/.test(js[1]), js[1]);
check('js 字符串着色', js[2].includes(STR), js[2]);
check('js 块注释跨行第 5 行', js[4].includes(COM));
check('js 块注释跨行第 6 行收尾', js[5].includes(COM) && stripAnsi(js[5]).includes('注释 */'));
check('js 模板字符串着色', js[6].includes(STR), js[6]);
const nums = highlightLines(['let a = 3.14; let b = 0xFF; let c = 1e6;'], 'js')[0];
check('js 数字着色', nums.split(NUM).length - 1 >= 3, String(nums.split(NUM).length - 1));

// ---------------------------------------------------------------- 其它语言
const py = highlightLines(['# 注释', 'def f(x: int) -> str:', '    """文档', '    字符串"""', '    return f"v={x}"'], 'python');
check('python 注释着色', py[0].includes(COM));
check('python def 关键字', py[1].includes(KEY + 'def'));
check('python 三引号跨行 1', py[2].includes(STR));
check('python 三引号跨行 2', py[3].includes(STR));
check('python 文本不丢', stripAnsi(py.join('')) === ['# 注释', 'def f(x: int) -> str:', '    """文档', '    字符串"""', '    return f"v={x}"'].join(''));

const bash = highlightLines(['#!/bin/bash', 'echo "hi" # 注释', 'for i in 1 2 3; do echo $i; done'], 'bash');
check('bash 注释着色', bash[1].includes(COM));
check('bash 关键字 for/do/done', bash[2].includes(KEY));

const html = highlightLines(['<div class="box">', '  <!-- 注释 -->', '  <span id="a">文字</span>', '</div>'], 'html');
check('html 标签着色', /\x1b\[38;5;204mdiv/.test(html[0]), html[0].slice(0, 40));
check('html 属性着色', /\x1b\[38;5;150mclass/.test(html[0]));
check('html 字符串着色', html[0].includes(STR));
check('html 注释着色', html[1].includes(COM));

const diff = highlightLines(['--- a/x.js', '+++ b/x.js', '@@ -1,3 +1,4 @@', '-old', '+new', ' same'], 'diff');
check('diff 删除行红色', diff[3].includes('\x1b[38;5;203m'));
check('diff 新增行绿色', diff[4].includes('\x1b[38;5;114m'));
check('diff hunk 头着色', diff[2].includes('@@'));

const sql = highlightLines(['SELECT id, name FROM users WHERE id = 1;'], 'sql');
check('sql 关键字着色', sql[0].includes(KEY), sql[0].slice(0, 30));

const yaml = highlightLines(['name: aurora', 'list:', '  - a', '# 注释'], 'yaml');
check('yaml 键着色', /\x1b\[38;5;150mname/.test(yaml[0]), yaml[0]);
check('yaml 注释着色', yaml[3].includes(COM));

const json = highlightLines(['{"a": 1, "b": [true, null], "c": "x"}'], 'json');
check('json 键/字符串着色', json[0].includes(STR));
check('json true/null 关键字', json[0].includes(KEY), json[0].slice(0, 60));

// 未知语言：原样返回，不加任何转义
const raw = ['const x = 1;', '  <!-- 原样 -->'];
const unknown = highlightLines(raw, 'klingon');
check('未知语言原样返回', unknown.length === 2 && unknown[0] === raw[0] && unknown[1] === raw[1]);
check('空语言原样返回', highlightLines(raw, '').join('') === raw.join(''));

// 所有支持的语言：文字内容必须完全不丢
let textOk = true;
let bad = '';
for (const lang of supportedLangs()) {
  const src = ['line one: a + b', 'second line {x: 1}', 'third -- ok'];
  const out = highlightLines(src, lang).join('');
  if (stripAnsi(out) !== src.join('')) {
    textOk = false;
    bad = lang;
  }
}
check('所有语言都不改变可见文字', textOk, bad);
check('高亮后的行数不变', highlightLines(['a', 'b', 'c'], 'js').length === 3);
check('highlightToAnsi 整段可用', highlightToAnsi('const a = 1;', 'js').includes(KEY));

// ---------------------------------------------------------------- Markdown
const md = [
  '# 标题',
  '',
  '一段 **加粗** 和 `行内代码`。',
  '',
  '- 列表 A',
  '- 列表 B',
  '',
  '```js',
  'const answer = 42; // 高亮',
  'console.log(answer);',
  '```',
  '',
  '| 列1 | 列2 |',
  '| --- | --- |',
  '| a | b |',
].join(NL);
const lines = renderMarkdown(md, 70);
const plain = stripAnsi(lines.join(NL));
check('markdown 标题渲染', plain.includes('标题'));
check('markdown 列表渲染', plain.includes('列表 A') && plain.includes('列表 B'));
check('markdown 表格渲染', plain.includes('列1') && plain.includes('a'));
check('markdown 代码块有边框', plain.includes('╭─') && plain.includes('╰'));
check('markdown 代码块标注语言与行数', plain.includes('js') && plain.includes('2 行'), plain.split(NL).find((l) => l.includes('╭─')));
check('markdown 代码块有高亮', lines.join('').includes(KEY), '');
check('markdown 行内代码保留文字', plain.includes('行内代码'));
check('markdown 每条不超过宽度', lines.every((l) => strWidth(l) <= 70), String(Math.max(...lines.map((l) => strWidth(l)))));

const longFence = ['```rust', ...Array.from({ length: 60 }, (_, i) => `let v${i} = ${i};`), '```'].join(NL);
const longLines = renderMarkdown(longFence, 70);
const longPlain = stripAnsi(longLines.join(NL));
check('超长代码块被折叠', longPlain.includes('还有 20 行'), longPlain.split(NL).find((l) => l.includes('还有')));
check('折叠后仍然有边框', longPlain.includes('╰'));

const width40 = renderMarkdown(md, 40);
check('窄宽度也不溢出', width40.every((l) => strWidth(l) <= 40), String(Math.max(...width40.map((l) => strWidth(l)))));

log('');
log(failed ? `FAILED ${failed} check(s)` : 'ALL HIGHLIGHT CHECKS PASSED');
process.exitCode = failed ? 1 : 0;

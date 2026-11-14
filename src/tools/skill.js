// Skill system: domain knowledge loaded on demand instead of bloating the system
// prompt. A skill is a markdown file, either
//   <project>/.agent/skills/<name>.md        (project-local)
//   <project>/.agent/skills/<name>/SKILL.md
//   ~/.agent/skills/<name>.md                (global)
//   ~/.agent/skills/<name>/SKILL.md
// Optional front matter:  ---\nname: x\ndescription: y\n---
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function skillDirs(cwd) {
  return [path.join(cwd, '.agent', 'skills'), path.join(os.homedir(), '.agent', 'skills')];
}

function parseSkill(file, scope) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let name = path.basename(file, '.md');
  if (path.basename(file) === 'SKILL.md') name = path.basename(path.dirname(file));
  let body = raw;
  let description = '';
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^(name|description)\s*:\s*(.+)$/i.exec(line.trim());
      if (!m) continue;
      if (m[1].toLowerCase() === 'name') name = m[2].trim();
      else description = m[2].trim();
    }
  }
  if (!description) {
    const para = body
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.replace(/^#+\s*/, '').trim())
      .find((p) => p && !p.startsWith('```'));
    description = (para || '').replace(/\s+/g, ' ').slice(0, 140);
  }
  return { name, description, file, scope, chars: body.length, body: body.trim() };
}

/** All skills visible from `cwd` (project skills win over global ones). */
export function listSkills(cwd = process.cwd()) {
  const found = new Map();
  for (const [i, dir] of skillDirs(cwd).entries()) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const file = e.isDirectory() ? path.join(dir, e.name, 'SKILL.md') : e.name.endsWith('.md') ? path.join(dir, e.name) : null;
      if (!file || !fs.existsSync(file)) continue;
      const sk = parseSkill(file, i === 0 ? '项目' : '全局');
      if (!sk) continue;
      if (!found.has(sk.name)) found.set(sk.name, sk);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(name, cwd = process.cwd()) {
  const q = String(name || '').toLowerCase();
  const all = listSkills(cwd);
  return all.find((s) => s.name.toLowerCase() === q) || all.find((s) => s.name.toLowerCase().includes(q)) || null;
}

/** One-line-per-skill block for the system prompt (empty string when none). */
export function skillsPrompt(cwd = process.cwd(), max = 20) {
  const all = listSkills(cwd).slice(0, max);
  if (!all.length) return '';
  const lines = all.map((s) => `- ${s.name}（${s.scope}）: ${s.description || '无描述'}`);
  return `可用技能（需要时用 skill 工具 load 名称，加载后按其中的步骤执行）：\n${lines.join('\n')}`;
}

export const skillTool = {
  name: 'skill',
  readOnly: true,
  description:
    '列出或加载技能（领域知识/流程说明）。actions: list（列出全部）、load（加载某个技能的完整内容）。当任务涉及某技能的领域时先 load 再动手。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'load'], description: 'list 列出技能，load 加载技能正文' },
      name: { type: 'string', description: 'load 时的技能名称' },
    },
    required: ['action'],
  },
  async execute(input, ctx = {}) {
    const cwd = ctx.cwd || process.cwd();
    const action = String(input.action || 'list').toLowerCase();
    if (action === 'load') {
      const sk = getSkill(input.name, cwd);
      if (!sk) {
        const names = listSkills(cwd).map((s) => s.name);
        return {
          isError: true,
          content: `没有找到技能 ${input.name || '(空)'}。可用技能: ${names.length ? names.join(', ') : '(无)'}`,
        };
      }
      const body = sk.body.length > 16000 ? sk.body.slice(0, 16000) + '\n…（已截断）' : sk.body;
      return {
        content: `# 技能 ${sk.name}（${sk.scope} · ${sk.file}）\n\n${body}`,
        // skill 元信息：UI 拿它把技能调用渲染成「✓ 技能名 · 技能·范围 · 字数」的封装块
        meta: {
          name: sk.name,
          scope: sk.scope,
          chars: sk.body.length,
          file: sk.file,
          description: sk.description,
          skill: { name: sk.name, scope: sk.scope, chars: sk.body.length, file: sk.file, description: sk.description },
          summary: sk.description || '',
        },
      };
    }
    const all = listSkills(cwd);
    if (!all.length) {
      return {
        content: `还没有任何技能。在 ${path.join(cwd, '.agent', 'skills')}/<名字>.md 或 ~/.agent/skills/<名字>.md 写一份 markdown 即可（可选 front matter: name/description）。`,
      };
    }
    return {
      content: all.map((s) => `- ${s.name}（${s.scope}, ${s.chars} 字）: ${s.description || '无描述'}`).join('\n'),
      meta: { count: all.length, summary: `共 ${all.length} 个技能：${all.map((s) => s.name).join('、')}` },
    };
  },
};

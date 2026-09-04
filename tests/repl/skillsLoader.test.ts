// tests/repl/skillsLoader.test.ts
// P5-5.1: dual-directory scan, name safety, frontmatter parsing, trigger/desc
// matching, caps, truncation, no-hit no-injection side effects.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSkills,
  matchSkills,
  parseSkillMarkdown,
  truncateSkillContent,
  SKILL_NAME_RE,
  MAX_MATCHED_SKILLS,
} from '../../src/cli/repl/skillsLoader.js';

const USER_ROOT = path.join(os.homedir(), '.panshalach', 'skills');
const saved = {
  user: null as string | null,
};
const MOCK = path.join(os.tmpdir(), 'pangu-skills-' + Date.now());

function writeSkill(base: string, name: string, body: string) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body, 'utf-8');
}

function skill(name: string, desc: string, triggers: string[], content = 'BODY-' + name): string {
  return `---\nname: ${name}\ndescription: ${desc}\ntriggers: [${triggers.join(', ')}]\n---\n${content}`;
}

describe('skillsLoader', () => {
  beforeEach(() => {
    saved.user = process.env.PANSHA_SKILLS_USER ?? null;
    process.env.PANSHA_SKILLS_USER = MOCK; // NOTE: loader uses os.homedir(), not env — see below
  });
  afterEach(() => {
    fs.rmSync(MOCK, { recursive: true, force: true });
    if (saved.user) process.env.PANSHA_SKILLS_USER = saved.user;
  });

  it('parseSkillMarkdown parses frontmatter + body; unclosed → null', () => {
    const ok = parseSkillMarkdown('---\nname: a\ndescription: desc\ntriggers: [x, y]\n---\nbody here');
    assert.ok(ok);
    assert.equal(ok!.name, 'a');
    assert.deepEqual(ok!.triggers, ['x', 'y']);
    assert.equal(ok!.content, 'body here');
    assert.equal(parseSkillMarkdown('no frontmatter'), null);
    assert.equal(parseSkillMarkdown('---\nname: a'), null); // unclosed
  });

  it('loadSkills scans user + project dirs; project wins on collision', () => {
    const ws = path.join(MOCK, 'ws');
    writeSkill(MOCK, 'shared', skill('shared', 'user version', ['alpha'], 'USER-BODY'));
    writeSkill(path.join(ws, '.panshalach', 'skills'), 'shared', skill('shared', 'project version', ['alpha'], 'PROJECT-BODY'));
    writeSkill(MOCK, 'only-user', skill('only-user', 'user only', ['gamma']));
    writeSkill(path.join(ws, '.panshalach', 'skills'), 'only-proj', skill('only-proj', 'proj only', ['delta']));

    const all = loadSkills(ws);
    const shared = all.find((s) => s.name === 'shared');
    assert.ok(shared, 'shared skill must exist');
    assert.equal(shared!.source, 'project', 'project version wins on collision');
    assert.ok(shared!.content.includes('PROJECT-BODY'));
    assert.ok(all.some((s) => s.name === 'only-user'));
    assert.ok(all.some((s) => s.name === 'only-proj'));
  });

  it('matchSkills: trigger hit, description fallback, cap 3, no-hit empty', () => {
    const skills = [
      { name: 'sql', description: '数据库与 SQL 优化', triggers: ['sql', '数据库'], content: 'S', source: 'user' as const, path: 'p' },
      { name: 'refactor', description: '重构指南', triggers: ['重构'], content: 'R', source: 'user' as const, path: 'p' },
      { name: 'docs', description: '撰写文档与注释', triggers: [], content: 'D', source: 'user' as const, path: 'p' },
    ];
    assert.deepEqual(matchSkills(skills, '请重构这个 SQL 查询').map((s) => s.name), ['sql', 'refactor']);
    assert.deepEqual(matchSkills(skills, '帮我写文档').map((s) => s.name), ['docs']);
    assert.deepEqual(matchSkills(skills, '无关任务'), []);
  });

  it('skill name regex restricts unsafe names', () => {
    assert.ok(SKILL_NAME_RE.test('my-skill'));
    assert.ok(SKILL_NAME_RE.test('a1'));
    assert.ok(!SKILL_NAME_RE.test('../evil'));
    assert.ok(!SKILL_NAME_RE.test('has space'));
    assert.ok(!SKILL_NAME_RE.test('UPPER'));
  });

  it('MAX_MATCHED_SKILLS caps and truncateSkillContent cuts at 2000', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      name: 's' + i, description: '', triggers: [`t${i}`], content: 'x', source: 'user' as const, path: 'p',
    }));
    const hits = matchSkills(many, 't0 t1 t2 t3');
    assert.ok(hits.length <= MAX_MATCHED_SKILLS);
    const long = 'x'.repeat(2500);
    assert.equal(truncateSkillContent(long).length, 2001); // 2000 + …
  });
});

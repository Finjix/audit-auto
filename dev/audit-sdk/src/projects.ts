import fs from 'node:fs';
import path from 'node:path';
import { Blocked } from './errors.ts';

/*
 * The game projects the plugin reviews for. Each has a fixed spec, the Markdown in its skill's references/rules.md (written from the
 * project's review standard), and a dynamic spec built from its review groups' chat (rules.ts). A fixed spec that is not written yet is a
 * placeholder: its file starts with PLACEHOLDER, and the project is reviewed against its dynamic spec alone.
 */

export interface Project { id: 'GOF' | 'GOT'; name: string; skill: string }

export const PROJECTS: Record<Project['id'], Project> = {
  GOF: { id: 'GOF', name: 'GOF（无尽冬日）', skill: 'gof-audit' },
  GOT: { id: 'GOT', name: 'GOT', skill: 'got-audit' },
};

export const PLACEHOLDER = '<!-- audit-auto: placeholder -->';

export function projectOf(value: unknown): Project {
  const id = typeof value === 'string' ? value.trim().toUpperCase() : '';
  const project = PROJECTS[id as Project['id']];
  if (!project) throw new Blocked(`不认识的项目：${String(value ?? '')}（只有 GOF 和 GOT）`);
  return project;
}

export interface FixedSpec { file: string; text: string; placeholder: boolean }

/** The project's fixed spec as the model is given it: the Markdown without its comments (notes for whoever maintains the file). */
export function fixedSpec(root: string, project: Project): FixedSpec {
  const file = path.join(root, 'skills', project.skill, 'references', 'rules.md');
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { throw new Blocked(`插件文件不完整：缺少 ${project.id} 的固定规范（skills/${project.skill}/references/rules.md），请联系管理员`); }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const placeholder = raw.trimStart().startsWith(PLACEHOLDER);
  return { file, placeholder, text: placeholder ? '' : raw.replace(/<!--[\s\S]*?-->\n?/g, '').trim() };
}

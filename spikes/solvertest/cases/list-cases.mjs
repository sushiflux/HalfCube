#!/usr/bin/env node
// Prints the one-line-per-case table of cases.json as Markdown; with --write <file> it replaces the text
// between <!-- CASE-LIST-BEGIN --> and <!-- CASE-LIST-END --> in that file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCases } from '../check/check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const doc = loadCases(path.join(here, 'cases.json'));

const rows = ['| Id | Group | Elements | Constraints | Steps | DOF | Algorithms | What it tests |', '|---|---|---:|---:|---:|---|---|---|'];
for (const c of doc.cases) {
  const dof = c.expect?.dof === undefined || c.expect.dof === null ? 'per step / n.a.' : String(c.expect.dof);
  const solved = c.expect?.solved === false ? ' (no solution expected)' : '';
  rows.push(`| ${c.id} | ${c.group} | ${c.elements.length} | ${c.constraints.length} | ${(c.steps || []).length || '-'} | ${dof} | ${c.run_algorithms ? 'DL, LM, BFGS' : 'DL'} | ${c.title}${solved} |`);
}
const algoEntries = doc.cases.reduce((s, c) => s + (c.run_algorithms ? c.run_algorithms.length : 1), 0);
const text = rows.join('\n') + `\n\n${doc.cases.length} cases, ${algoEntries} result entries (cases with several algorithms count once per algorithm).\n`;

const wi = process.argv.indexOf('--write');
if (wi >= 0) {
  const file = path.resolve(process.argv[wi + 1]);
  const src = fs.readFileSync(file, 'utf8');
  const a = src.indexOf('<!-- CASE-LIST-BEGIN -->'), b = src.indexOf('<!-- CASE-LIST-END -->');
  if (a < 0 || b < 0) throw new Error('markers not found');
  fs.writeFileSync(file, `${src.slice(0, a)}<!-- CASE-LIST-BEGIN -->\n${text}${src.slice(b)}`);
  console.log(`updated ${file}`);
} else console.log(text);

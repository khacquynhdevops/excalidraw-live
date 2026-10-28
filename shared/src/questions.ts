// Questions one role leaves for another whose session is not running, in
// <diagrams>/questions.jsonl. The file is append-only (ask, answer and seen
// events, one per line) so several sessions can write it at once and git
// keeps the whole conversation.
import { appendFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export interface Question {
  id: string;
  at: string;
  from: string;
  to: string;
  ref: string;
  text: string;
  answer?: { at: string; by: string; text: string; ref?: string };
  // The asker has been shown the answer.
  answerSeen?: boolean;
}

type Event =
  | ({ type: 'ask' } & Omit<Question, 'answer' | 'answerSeen'>)
  | { type: 'answer'; questionId: string; at: string; by: string; text: string; ref?: string }
  | { type: 'seen'; questionId: string; role: string };

const file = (dir: string) => join(dir, 'questions.jsonl');
const append = (dir: string, e: Event) => appendFile(file(dir), JSON.stringify(e) + '\n');

export async function readQuestions(dir: string): Promise<Question[]> {
  let raw = '';
  try {
    raw = await readFile(file(dir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const byId = new Map<string, Question>();
  for (const line of raw.split('\n')) {
    let e: Event;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // blank, or cut short by a crash
    }
    if (e.type === 'ask') {
      const { type, ...q } = e;
      byId.set(q.id, q);
      continue;
    }
    const q = byId.get(e.questionId);
    if (!q) continue;
    if (e.type === 'answer') q.answer = { at: e.at, by: e.by, text: e.text, ...(e.ref ? { ref: e.ref } : {}) };
    else if (e.role === q.from) q.answerSeen = true;
  }
  return [...byId.values()];
}

export async function askQuestion(dir: string, q: { from: string; to: string; ref: string; text: string }): Promise<Question> {
  const question: Question = { id: `q_${randomBytes(4).toString('hex')}`, at: new Date().toISOString(), ...q };
  await append(dir, { type: 'ask', ...question });
  return question;
}

export async function answerQuestion(dir: string, a: { questionId: string; by: string; text: string; ref?: string }): Promise<Question> {
  const q = (await readQuestions(dir)).find((x) => x.id === a.questionId);
  if (!q) throw new Error(`no question ${a.questionId}`);
  if (q.to !== a.by) throw new Error(`${q.id} was asked to ${q.to}, not ${a.by}`);
  if (q.answer) throw new Error(`${q.id} is already answered`);
  const answer = { at: new Date().toISOString(), by: a.by, text: a.text, ...(a.ref ? { ref: a.ref } : {}) };
  await append(dir, { type: 'answer', questionId: q.id, ...answer });
  return { ...q, answer };
}

// What a role should hear about: questions waiting for it, and answers to
// its own questions it has not been shown yet.
export async function inboxFor(dir: string, role: string) {
  const all = await readQuestions(dir);
  return {
    pending: all.filter((q) => q.to === role && !q.answer),
    answered: all.filter((q) => q.from === role && q.answer && !q.answerSeen)
  };
}

export async function markSeen(dir: string, role: string, ids: string[]) {
  for (const questionId of ids) await append(dir, { type: 'seen', questionId, role });
}

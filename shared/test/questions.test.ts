import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerQuestion, askQuestion, inboxFor, markSeen, readQuestions } from '../src/questions.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xl-q-'));
});

describe('questions between roles', () => {
  it('starts empty when there is no file', async () => {
    expect(await readQuestions(dir)).toEqual([]);
  });

  it('appends a question as one json line, kept in git', async () => {
    const q = await askQuestion(dir, { from: 'swe', to: 'po', ref: 'dl://d_seq@3#pay', text: 'Refunds too?' });
    expect(q).toMatchObject({ from: 'swe', to: 'po', ref: 'dl://d_seq@3#pay', text: 'Refunds too?' });
    expect(q.id).toMatch(/^q_[a-z0-9]+$/);
    const lines = readFileSync(join(dir, 'questions.jsonl'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'ask', id: q.id });
  });

  it('shows a role what it was asked, then the asker the answer once', async () => {
    const q = await askQuestion(dir, { from: 'swe', to: 'po', ref: 'dl://d_seq', text: 'Refunds too?' });
    expect((await inboxFor(dir, 'po')).pending.map((x) => x.id)).toEqual([q.id]);
    expect((await inboxFor(dir, 'swe')).pending).toEqual([]);

    await answerQuestion(dir, { questionId: q.id, by: 'po', text: 'Yes, within 30 days', ref: 'dl://d_over@5#refund' });
    expect((await inboxFor(dir, 'po')).pending).toEqual([]);
    const { answered } = await inboxFor(dir, 'swe');
    expect(answered).toHaveLength(1);
    expect(answered[0].answer).toMatchObject({ by: 'po', text: 'Yes, within 30 days', ref: 'dl://d_over@5#refund' });

    await markSeen(dir, 'swe', answered.map((x) => x.id));
    expect((await inboxFor(dir, 'swe')).answered).toEqual([]);
  });

  it('lets only the asked role answer, and only once', async () => {
    const q = await askQuestion(dir, { from: 'swe', to: 'po', ref: 'dl://d_seq', text: '?' });
    await expect(answerQuestion(dir, { questionId: 'q_nope', by: 'po', text: 'x' })).rejects.toThrow('no question q_nope');
    await expect(answerQuestion(dir, { questionId: q.id, by: 'tester', text: 'x' })).rejects.toThrow(`${q.id} was asked to po, not tester`);
    await answerQuestion(dir, { questionId: q.id, by: 'po', text: 'x' });
    await expect(answerQuestion(dir, { questionId: q.id, by: 'po', text: 'y' })).rejects.toThrow(`${q.id} is already answered`);
  });

  it('skips a line cut short by a crash', async () => {
    const q = await askQuestion(dir, { from: 'swe', to: 'po', ref: 'dl://d_seq', text: '?' });
    appendFileSync(join(dir, 'questions.jsonl'), '{"type":"ask","id":"q_bro');
    expect((await readQuestions(dir)).map((x) => x.id)).toEqual([q.id]);
  });
});

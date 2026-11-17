#!/usr/bin/env node
// statusLine: the open board, whose it is, the role and mode of this session,
// and its unread count, so the user sees which board they are changing.
// Empty when no board is open.
import { boardStatus, projectDir } from './board-status.mjs';

const s = await boardStatus(await projectDir());
if (s) {
  const mine = s.as === s.owner;
  const writer = s.mode === 'writer';
  const icon = !writer ? '👀' : mine ? '✏️' : '⚠️';
  const doing = !writer ? ' read-only' : mine ? '' : ' editing';
  process.stdout.write(`${icon} ${s.name}${mine ? '' : ` (${s.owner}'s)`} · ${s.as}${doing}: ${s.unread} unread`);
}

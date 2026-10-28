#!/usr/bin/env node
// statusLine: the open board and its unread count. Empty when no board is open.
import { boardStatus, projectDir } from './board-status.mjs';

const s = await boardStatus(await projectDir());
if (s) process.stdout.write(`✏️ ${s.name}: ${s.unread} thay đổi chưa đọc`);

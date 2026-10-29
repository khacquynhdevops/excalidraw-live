import { describe, it, expect } from 'vitest';
import { conventionLine } from '../src/conventions.js';

describe('conventionLine', () => {
  it('names the notation, house rules, colours and mistakes to avoid', () => {
    const line = conventionLine('c4-container')!;
    expect(line).toMatch(/^c4-container: draw it as an expert in the C4 model \(container level\) would/);
    expect(line).toContain('Here: a dashed frame is the system boundary.');
    expect(line).toContain('service #e5dbff/#5f3dc4');
    expect(line).toMatch(/Avoid external systems far from the container that calls them: .*\.$/);
  });

  it('leaves out what a kind does not have', () => {
    expect(conventionLine('state')).not.toMatch(/Here:|Avoid/);
    expect(conventionLine('free')).toBeUndefined();
  });
});

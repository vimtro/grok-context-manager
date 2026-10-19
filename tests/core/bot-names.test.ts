import { describe, expect, it } from 'vitest';
import { botIdFromName, BotIdSchema, parseBotNames } from '@gcm/core';

describe('botIdFromName', () => {
  it('derives valid, readable IDs from names', () => {
    expect(botIdFromName('Chief of Staff')).toBe('chief-of-staff');
    expect(botIdFromName('  Sales!! ')).toBe('sales');
    expect(botIdFromName('Café Bot')).toBe('cafe-bot');
    expect(botIdFromName('R&D / Ops 2')).toBe('r-d-ops-2');
    const long = botIdFromName('x'.repeat(30) + ' ' + 'y'.repeat(60));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(BotIdSchema.safeParse(long).success).toBe(true);
  });

  it('gives non-Latin names a stable hashed ID', () => {
    const id = botIdFromName('مبيعات');
    expect(id).toMatch(/^bot-[0-9a-f]{8}$/);
    expect(botIdFromName(' مبيعات ')).toBe(id);
  });
});

describe('parseBotNames', () => {
  it('keeps bot names from a pasted sidebar and ignores times, previews and app labels', () => {
    const pasted = [
      'Sales',
      '2h',
      'Research Bot',
      'Yesterday',
      'Can you send the Q3 renewal numbers to the finance team today?',
      '- Chief of Staff',
      '1. Support',
      '@Ops',
      'sales',
      '10:42 AM',
      'New chat',
      'https://cursor.com/bots',
      '',
    ].join('\n');
    const r = parseBotNames(pasted);
    expect(r.names).toEqual([
      { id: 'sales', name: 'Sales' },
      { id: 'research-bot', name: 'Research Bot' },
      { id: 'chief-of-staff', name: 'Chief of Staff' },
      { id: 'support', name: 'Support' },
      { id: 'ops', name: 'Ops' },
    ]);
    expect(r.ignored).toEqual(
      expect.arrayContaining([
        '2h',
        'Yesterday',
        '10:42 AM',
        'New chat',
        'https://cursor.com/bots',
      ]),
    );
  });

  it('accepts comma- or semicolon-separated names on one line', () => {
    expect(parseBotNames('Sales, Research; Chief of Staff').names.map((n) => n.id)).toEqual([
      'sales',
      'research',
      'chief-of-staff',
    ]);
  });
});

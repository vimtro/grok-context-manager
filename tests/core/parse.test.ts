import { describe, expect, it } from 'vitest';
import { detectFormat, parseConversation } from '@gcm/core';

describe('parseConversation', () => {
  it('parses plain-text speaker lines with timestamps and multi-line bodies', () => {
    const r = parseConversation(
      [
        '[2026-10-01 09:00] User: Hello there',
        'second line',
        'Assistant (10:05): Hi!',
        'User: Thanks',
      ].join('\n'),
    );
    expect(r.format).toBe('text');
    expect(r.messages).toHaveLength(3);
    expect(r.messages[0]).toMatchObject({
      role: 'user',
      content: 'Hello there\nsecond line',
      timestamp: '2026-10-01 09:00',
    });
    expect(r.messages[1]).toMatchObject({ role: 'assistant', timestamp: '10:05' });
  });

  it('does not treat inline labels such as "Note:" or "TODO:" as speakers', () => {
    const r = parseConversation(
      [
        'User: plan for today',
        'Note: check the budget',
        'TODO: send invoice',
        'Assistant: ok',
      ].join('\n'),
    );
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]!.content).toContain('TODO: send invoice');
  });

  it('maps the bot profile name to the assistant role', () => {
    const r = parseConversation(
      'User: hi\nChief of Staff: hello\nUser: status?\nChief of Staff: all good',
      'auto',
      {
        assistantNames: ['Chief of Staff'],
      },
    );
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('infers the assistant in a two-party conversation and says so', () => {
    const r = parseConversation('User: hi\nMarketing: hello\nUser: go\nMarketing: done');
    expect(r.messages[1]!.role).toBe('assistant');
    expect(r.warnings.join(' ')).toMatch(/treated as the bot/);
  });

  it('parses Markdown heading transcripts', () => {
    const r = parseConversation('### User\n\nHello\n\n### Assistant\n\nHi there\n');
    expect(r.format).toBe('markdown');
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('parses JSON message lists with content parts and skips non-text parts', () => {
    const r = parseConversation(
      JSON.stringify({
        messages: [
          { role: 'user', content: 'Q', timestamp: 1760000000 },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'A' },
              { type: 'image', url: 'x' },
            ],
          },
          { role: 'assistant', content: '' },
        ],
      }),
    );
    expect(r.format).toBe('json');
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]!.timestamp).toMatch(/^2025-/);
    expect(r.messages[1]!.content).toBe('A');
    expect(r.warnings.join(' ')).toMatch(/without text content/);
  });

  it('parses JSONL and reports invalid lines', () => {
    const r = parseConversation(
      '{"role":"user","content":"a"}\n{bad json}\n{"role":"assistant","content":"b"}',
      'jsonl',
    );
    expect(r.messages).toHaveLength(2);
    expect(r.warnings.join(' ')).toMatch(/Line 2/);
  });

  it('imports unlabeled notes as unknown-role paragraphs with a warning', () => {
    const r = parseConversation('First note.\n\nSecond note.');
    expect(r.messages.map((m) => m.role)).toEqual(['unknown', 'unknown']);
    expect(r.warnings[0]).toMatch(/No speaker labels/);
  });

  it('flags truncation markers', () => {
    const r = parseConversation('User: hi\n[truncated]\nAssistant: ok');
    expect(r.truncationSuspected).toBe(true);
  });

  it('rejects JSON without a message list', () => {
    expect(() => parseConversation('{"foo": 1}', 'json')).toThrow(/message list/);
  });

  it('detects formats', () => {
    expect(detectFormat('[{"role":"user","content":"x"}]')).toBe('json');
    expect(detectFormat('{"a":1}\n{"b":2}')).toBe('jsonl');
    expect(detectFormat('# Title\ntext')).toBe('markdown');
    expect(detectFormat('User: hi')).toBe('text');
  });
});

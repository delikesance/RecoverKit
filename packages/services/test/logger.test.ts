import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger';

function capture() {
  const lines: any[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const l of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(l));
      cb();
    },
  });
  return { lines, stream };
}

describe('logger', () => {
  it('émet du JSON structuré avec les champs de corrélation', () => {
    const { lines, stream } = capture();
    const log = createLogger({ stream }).child({ eventId: 'evt_1', caseId: 'c1', tenantId: 't1' });
    log.info({ step: 2 }, 'relance envoyée');
    expect(lines[0]).toMatchObject({ eventId: 'evt_1', caseId: 'c1', tenantId: 't1', step: 2, msg: 'relance envoyée', level: 'info' });
  });

  it('masque les secrets et les emails dans les logs', () => {
    const { lines, stream } = capture();
    const log = createLogger({ stream });
    log.info({ token: 'secret-token', authorization: 'Bearer x', apiKey: 'k', email: 'a@b.c' }, 'x');
    expect(JSON.stringify(lines[0])).not.toContain('secret-token');
    expect(JSON.stringify(lines[0])).not.toContain('Bearer x');
    expect(lines[0].token).toBe('[masqué]');
    expect(lines[0].email).toBe('[masqué]');
  });

  it('respecte le niveau', () => {
    const { lines, stream } = capture();
    const log = createLogger({ stream, level: 'warn' });
    log.info('ignoré');
    log.warn('gardé');
    expect(lines.map((l) => l.msg)).toEqual(['gardé']);
  });
});

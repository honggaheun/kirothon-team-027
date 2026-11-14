// Tests for the stage screen text rules (ui/format.js); expected values come from the stage-ui design tables.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  actionLabel, actionTone, bandInfo, bandText, cardBadge, choiceLabel, diffSeg, formatExample,
  reasonPhrase, runsFor, shrinkView, stripBasis, summaryText,
} from '../../ui/format.js';

const word = fc.string({ unit: fc.constantFrom(...'abcxyz019_-'.split('')), minLength: 1, maxLength: 12 });
const reqId = fc.tuple(fc.integer({ min: 1, max: 9 }), fc.integer({ min: 1, max: 9 })).map(([n, m]) => `signup:R${n}.${m}`);
const red = (id: string, extra: Record<string, unknown> = {}) => ({ id, verdict: 'red', reason: 'test-failed', tests: [], ...extra });
const green = (id: string) => ({ id, verdict: 'green', reason: 'all-passed', tests: [] });

describe('formatExample', () => {
  it('[stage-ui:R4.1] design table examples', () => {
    expect(formatExample('["aaa000"]')).toBe('aaa000');
    expect(formatExample('["a",3]')).toBe('a, 3');
    expect(formatExample('[""]')).toBe('""');
    expect(formatExample('[{"x":1}]')).toBe('{"x":1}');
    expect(formatExample('[new Date("2013-06-15T00:00:00.000Z")]')).toBe('new Date("2013-06-15T00:00:00.000Z")');
  });

  it('[stage-ui:R4.1] JSON arrays: strings without quotes ("" when empty), others as JSON, joined by ", "', () => {
    const el = fc.oneof(fc.string({ maxLength: 8 }), fc.constant(''), fc.integer(), fc.boolean(), fc.constant(null), fc.dictionary(word, fc.integer(), { maxKeys: 2 }));
    fc.assert(
      fc.property(fc.array(el, { minLength: 1, maxLength: 5 }), (arr) => {
        const want = arr.map((e) => (typeof e === 'string' ? (e === '' ? '""' : e) : JSON.stringify(e))).join(', ');
        expect(formatExample(JSON.stringify(arr))).toBe(want);
      }),
    );
  });

  it('[stage-ui:R4.1] text that is not a JSON array loses only the outer brackets', () => {
    fc.assert(
      fc.property(word, (w) => {
        const inner = 'new Date("' + w + '")';
        expect(formatExample('[' + inner + ']')).toBe(inner);
      }),
    );
  });
});

describe('reasonPhrase', () => {
  it('[stage-ui:R4.2] design table examples', () => {
    expect(reasonPhrase(red('signup:R2.3', { counterexample: '["aaa000"]' }))).toBe('반례 aaa000');
    expect(reasonPhrase(red('signup:R2.3'))).toBe('검사 실패');
    const seal = { path: 'tests/signup/R2.3.prop.test.ts', problem: 'changed' };
    expect(reasonPhrase(red('signup:R2.3', { reason: 'seal-broken', brokenSeals: [seal] }))).toBe('봉인 깨짐 tests/signup/R2.3.prop.test.ts');
    expect(reasonPhrase(red('signup:R2.3', { reason: 'seal-broken', brokenSeals: [seal, { path: 'b', problem: 'missing' }] }))).toBe('봉인 깨짐 tests/signup/R2.3.prop.test.ts 외 1');
    expect(reasonPhrase(red('signup:R2.3', { reason: 'run-failed' }))).toBe('검사 실행 실패');
  });

  it('[stage-ui:R4.2] seal-broken names the first path and counts the rest', () => {
    fc.assert(
      fc.property(fc.array(word, { minLength: 1, maxLength: 6 }), (paths) => {
        const item = red('signup:R1.1', { reason: 'seal-broken', brokenSeals: paths.map((p) => ({ path: p, problem: 'changed' })) });
        expect(reasonPhrase(item)).toBe('봉인 깨짐 ' + paths[0] + (paths.length > 1 ? ' 외 ' + (paths.length - 1) : ''));
      }),
    );
  });

  it('[stage-ui:R4.2] test-failed with a counterexample shows "반례 " and its text', () => {
    fc.assert(
      fc.property(fc.array(word, { minLength: 1, maxLength: 3 }), (vals) => {
        expect(reasonPhrase(red('signup:R2.3', { counterexample: JSON.stringify(vals) }))).toBe('반례 ' + vals.join(', '));
      }),
    );
  });
});

describe('bandText', () => {
  const rep = (overall: string, requirements: unknown[], extra: Record<string, unknown> = {}) => ({ overall, requirements, ...extra });

  it('[stage-ui:R4.7] no report waits for guard check; green says everything matches', () => {
    expect(bandText(null, null)).toEqual({ tone: 'none', text: '판정 없음 · guard check를 기다리는 중' });
    fc.assert(
      fc.property(fc.uniqueArray(reqId, { minLength: 1, maxLength: 6 }), (ids) => {
        expect(bandText(rep('green', ids.map(green)), null)).toEqual({ tone: 'green', text: '모든 요구사항이 코드와 일치' });
      }),
    );
  });

  it('[stage-ui:R4.6] yellow names the first yellow and its reason, then counts the rest', () => {
    const y = (id: string, reason: string) => ({ id, verdict: 'yellow', reason, tests: [] });
    expect(bandText(rep('yellow', [green('signup:R1.1'), y('signup:R2.3', 'stale')]), null).text).toBe('확인 안 됨 · signup:R2.3 검사를 봉인한 뒤 스펙 문장이 바뀜');
    fc.assert(
      fc.property(fc.uniqueArray(reqId, { minLength: 1, maxLength: 6 }), fc.constantFrom('no-tests', 'stale'), (ids, reason) => {
        const b = bandText(rep('yellow', ids.map((id) => y(id, reason))), null);
        const why = reason === 'stale' ? '검사를 봉인한 뒤 스펙 문장이 바뀜' : '검사 없음';
        expect(b).toEqual({ tone: 'yellow', text: '확인 안 됨 · ' + ids[0] + ' ' + why + (ids.length > 1 ? ' 외 ' + (ids.length - 1) + '건' : '') });
      }),
    );
  });

  it('[stage-ui:R4.3][stage-ui:R4.5] red: first red, its reason, the rest counted, decision pending', () => {
    expect(bandText(rep('red', [green('signup:R1.1'), red('signup:R2.3', { counterexample: '["aaa000"]' })]), null).text)
      .toBe('signup:R2.3 위반 · 반례 aaa000 · 사람 결정 대기');
    expect(bandText(rep('red', [red('signup:R2.3', { reason: 'seal-broken', brokenSeals: [{ path: 'tests/signup/R2.3.prop.test.ts', problem: 'changed' }] })]), null).text)
      .toBe('signup:R2.3 위반 · 봉인 깨짐 tests/signup/R2.3.prop.test.ts · 사람 결정 대기');
    fc.assert(
      fc.property(fc.uniqueArray(reqId, { minLength: 1, maxLength: 6 }), word, (ids, v) => {
        const b = bandText(rep('red', ids.map((id) => red(id, { counterexample: JSON.stringify([v]) }))), { approved: [] });
        const more = ids.length > 1 ? ' 외 ' + (ids.length - 1) + '건' : '';
        expect(b).toEqual({ tone: 'red', text: ids[0] + ' 위반 · 반례 ' + v + more + ' · 사람 결정 대기' });
      }),
    );
  });

  it('[stage-ui:R4.5] every red approved: decision recorded with the first red choice; one missing keeps it pending', () => {
    const two = [red('signup:R2.1', { counterexample: '["12345678"]' }), red('signup:R2.2')];
    const both = { approved: [{ requirement: 'signup:R2.1', choice: 'revert-code' }, { requirement: 'signup:R2.2', choice: 'revert-code' }] };
    expect(bandText(rep('red', two), both).text).toBe('signup:R2.1 위반 · 반례 12345678 외 1건 · 사람 결정 기록됨 · 코드를 되돌린다');
    fc.assert(
      fc.property(fc.uniqueArray(reqId, { minLength: 2, maxLength: 6 }), fc.constantFrom('revert-code', 'edit-spec'), fc.nat(), (ids, choice, k) => {
        const items = ids.map((id) => red(id));
        const all = { approved: ids.map((id) => ({ requirement: id, choice })) };
        expect(bandText(rep('red', items), all).text.endsWith(' · 사람 결정 기록됨 · ' + choiceLabel(choice))).toBe(true);
        const skip = k % ids.length;
        const some = { approved: all.approved.filter((_, i) => i !== skip) };
        expect(bandText(rep('red', items), some).text.endsWith(' · 사람 결정 대기')).toBe(true);
      }),
    );
  });

  it('[stage-ui:R4.4] any run-failed red: "검사 실행 실패" with the run error', () => {
    const six = ['R1.1', 'R1.2', 'R2.1', 'R2.2', 'R2.3', 'R3.1'].map((r) => red('signup:' + r, { reason: 'run-failed' }));
    expect(bandText(rep('red', six, { runError: 'vitest output is not JSON' }), null).text).toBe('검사 실행 실패 · vitest output is not JSON · 사람 결정 대기');
    fc.assert(
      fc.property(fc.uniqueArray(reqId, { minLength: 2, maxLength: 6 }), fc.nat(), fc.option(word, { nil: undefined }), (ids, k, err) => {
        const items = ids.map((id, i) => red(id, i === k % ids.length ? { reason: 'run-failed' } : { counterexample: '["x"]' }));
        const b = bandText(rep('red', items, err === undefined ? {} : { runError: err }), null);
        expect(b.text).toBe('검사 실행 실패' + (err === undefined ? '' : ' · ' + err) + ' · 사람 결정 대기');
      }),
    );
  });
});

describe('summaryText', () => {
  it('[stage-ui:R4.8] "통과 g · 위반 r", with " · 노랑 y" in the middle only when y > 0', () => {
    expect(summaryText({ green: 6, yellow: 0, red: 0 })).toBe('통과 6 · 위반 0');
    expect(summaryText({ green: 5, yellow: 1, red: 0 })).toBe('통과 5 · 노랑 1 · 위반 0');
    fc.assert(
      fc.property(fc.nat(50), fc.nat(50), fc.nat(50), (g, y, r) => {
        expect(summaryText({ green: g, yellow: y, red: r })).toBe('통과 ' + g + (y > 0 ? ' · 노랑 ' + y : '') + ' · 위반 ' + r);
      }),
    );
  });
});

describe('actionLabel and actionTone', () => {
  it('[stage-ui:R6.2] the badge is the action in capitals', () => {
    expect(['write', 'shell', 'block', 'hook', 'human', 'save'].map(actionLabel)).toEqual(['WRITE', 'SHELL', 'BLOCK', 'HOOK', 'HUMAN', 'SAVE']);
    fc.assert(fc.property(fc.string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz-'.split('')), minLength: 1, maxLength: 10 }), (a) => {
      expect(actionLabel(a)).toBe(a.toUpperCase());
    }));
  });

  it('[stage-ui:R6.3] write · hook · block · human have their own look, every other action is plain', () => {
    for (const a of ['write', 'hook', 'block', 'human']) expect(actionTone(a)).toBe(a);
    expect(actionTone('shell')).toBe('plain');
    expect(actionTone('save')).toBe('plain');
    fc.assert(fc.property(word, (a) => {
      fc.pre(!['write', 'hook', 'block', 'human'].includes(a));
      expect(actionTone(a)).toBe('plain');
    }));
  });
});

describe('cardBadge', () => {
  it('[stage-ui:R3.3] green 통과 · yellow 확인 안 됨 · red 위반 (run-failed 실행 실패) · none 대기', () => {
    expect(cardBadge(green('signup:R1.1'))).toEqual({ state: 'pass', text: '통과' });
    expect(cardBadge({ id: 'signup:R1.1', verdict: 'yellow', reason: 'stale' })).toEqual({ state: 'yellow', text: '확인 안 됨' });
    expect(cardBadge(red('signup:R1.1', { reason: 'run-failed' }))).toEqual({ state: 'red', text: '실행 실패' });
    expect(cardBadge(null)).toEqual({ state: '', text: '대기' });
    fc.assert(fc.property(fc.constantFrom('test-failed', 'seal-broken'), (reason) => {
      expect(cardBadge(red('signup:R2.3', { reason }))).toEqual({ state: 'red', text: '위반' });
    }));
  });
});

describe('stripBasis', () => {
  it('[stage-ui:R5.1] a trailing "(근거: <basis>)" leaves the sentence; otherwise the text stays', () => {
    const b = '개인정보 보호법 제22조의2 제1항';
    expect(stripBasis('WHEN … 한다(SHALL) (근거: ' + b + ')', b)).toBe('WHEN … 한다(SHALL)');
    fc.assert(fc.property(word, word, (s, basis) => {
      const text = 'WHEN ' + s + ' THEN 시스템은 거절해야 한다(SHALL)';
      expect(stripBasis(text + ' (근거: ' + basis + ')', basis)).toBe(text);
      expect(stripBasis(text, basis)).toBe(text);
      expect(stripBasis(text + ' (근거: ' + basis + ')', null)).toBe(text + ' (근거: ' + basis + ')');
    }));
  });
});

describe('diffSeg', () => {
  it('[stage-ui:R3.8] finds the changed segment between two lines', () => {
    const a = 'export const MIN_PASSWORD_LENGTH = 8; // [R2.3]', b = 'export const MIN_PASSWORD_LENGTH = 6; // [R2.3]';
    expect(diffSeg(a, b)).toEqual({ p: a.indexOf('8'), from: '8', to: '6' });
    fc.assert(fc.property(fc.string({ maxLength: 12 }), fc.string({ maxLength: 4 }), fc.string({ maxLength: 4 }), fc.string({ maxLength: 12 }), (pre, x, y, suf) => {
      const s = pre + x + suf, t = pre + y + suf, d = diffSeg(s, t);
      expect(s.slice(0, d.p) + d.from + s.slice(d.p + d.from.length)).toBe(s);
      expect(t.slice(0, d.p) + d.to + t.slice(d.p + d.to.length)).toBe(t);
      expect(s.slice(0, d.p)).toBe(t.slice(0, d.p));
      expect(s.slice(d.p + d.from.length)).toBe(t.slice(d.p + d.to.length));
      expect(d.from.length + d.to.length).toBeLessThanOrEqual(x.length + y.length);
    }));
  });
});

describe('choiceLabel', () => {
  it('[stage-ui:R7.3] revert-code and edit-spec labels', () => {
    expect(choiceLabel('revert-code')).toBe('코드를 되돌린다');
    expect(choiceLabel('edit-spec')).toBe('스펙을 고친다');
  });
});

describe('runsFor', () => {
  it('[stage-ui:R8.1] the record of the first red requirement (report order) that has one', () => {
    fc.assert(
      fc.property(fc.uniqueArray(reqId, { minLength: 1, maxLength: 6 }), fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }), fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }), (ids, isRed, hasRun) => {
        const items = ids.map((id, i) => (isRed[i] ? red(id) : green(id)));
        const runs = new Map<string, unknown>();
        ids.forEach((id, i) => { if (hasRun[i]) runs.set(id.replace(':', '__') + '.json', { requirement: id, inputs: [], shrinkPath: [] }); });
        const k = ids.findIndex((_, i) => isRed[i] && hasRun[i]);
        const got = runsFor({ overall: 'red', requirements: items }, runs);
        if (k < 0) expect(got).toBeNull();
        else {
          expect(got!.item.id).toBe(ids[k]);
          expect(got!.name).toBe(ids[k].replace(':', '__') + '.json');
        }
      }),
    );
  });
});

describe('shrinkView', () => {
  it('[stage-ui:R8.3] five or fewer values stay; more keep the first 2 and last 3 around a gap', () => {
    fc.assert(
      fc.property(fc.array(word, { maxLength: 12 }), (p) => {
        const v = shrinkView(p);
        if (p.length <= 5) expect(v).toEqual(p);
        else expect(v).toEqual([p[0], p[1], null, p[p.length - 3], p[p.length - 2], p[p.length - 1]]);
      }),
    );
    expect(shrinkView(['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(shrinkView(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', 'b', null, 'd', 'e', 'f']);
  });
});

describe('bandInfo', () => {
  it('[stage-ui:R8.1] "<ID> · 검사 <runs>회 · 줄이기 <shrinks>회", counting the record when the report has no numbers', () => {
    expect(bandInfo(red('signup:R2.3', { runs: 10, shrinks: 7 }), { inputs: [], shrinkPath: [] })).toBe('signup:R2.3 · 검사 10회 · 줄이기 7회');
    fc.assert(
      fc.property(reqId, fc.nat(20), fc.integer({ min: 1, max: 20 }), (id, n, m) => {
        const run = { inputs: Array.from({ length: n }, () => ({ v: '"a"', ok: true })), shrinkPath: Array.from({ length: m }, () => '"a"') };
        expect(bandInfo(red(id), run)).toBe(id + ' · 검사 ' + n + '회 · 줄이기 ' + (m - 1) + '회');
      }),
    );
  });
});

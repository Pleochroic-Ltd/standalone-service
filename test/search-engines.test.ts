import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SearchEngine } from '../src/host.ts';
import { firstOf } from '../src/engines/search.ts';
import type { SearchRequest } from '../src/types.ts';

const request: SearchRequest = { query: 'hello' };
const signal = new AbortController().signal;

const okEngine = (id: string): SearchEngine => ({ id, search: async () => ({ results: [], backend: id }) });
const failingEngine = (id: string, message = `${id} failed`): SearchEngine => ({ id, search: async () => { throw new Error(message); } });

test('the first engine to answer wins', async () => {
  const engine = firstOf(okEngine('a'), okEngine('b'));
  assert.equal((await engine.search(request, signal)).backend, 'a');
});

test('a failing (or unconfigured) first engine falls through to the next', async () => {
  const engine = firstOf(failingEngine('brave', 'brave: BRAVE_API_KEY is not set'), okEngine('tavily'));
  assert.equal((await engine.search(request, signal)).backend, 'tavily');
});

test('every engine failing throws the last error, not a silent empty result', async () => {
  const engine = firstOf(failingEngine('a', 'a is down'), failingEngine('b', 'b is down'));
  await assert.rejects(() => engine.search(request, signal), /b is down/);
});

test('no engines at all throws rather than hanging or returning nothing', async () => {
  const engine = firstOf();
  await assert.rejects(() => engine.search(request, signal));
});

test('id names the chain, so a log naming it is at least legible', () => {
  const engine = firstOf(okEngine('brave'), okEngine('tavily'));
  assert.equal(engine.id, 'firstOf(brave,tavily)');
});

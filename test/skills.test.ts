import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { testHost, startService, type TestService } from './helpers.ts';

let service: TestService;
before(async () => { service = await startService(testHost()); });
after(() => service.stop());

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

test('PUT creates a skill; GET /skills/:scope/:name answers { files } only, with an ETag', async () => {
  const files = [
    { path: 'SKILL.md', encoding: 'utf8', content: skillMd('demo-skill', 'Does a demo thing') },
    { path: 'scripts/run.py', encoding: 'utf8', content: 'print("hi")\n' },
  ];
  const put = await service.call('PUT', '/v1/skills/global/demo-skill', { body: { files } });
  assert.equal(put.status, 200);
  const meta = await put.json();
  assert.equal(meta.description, 'Does a demo thing');
  assert.equal(meta.files, undefined);

  const get = await service.call('GET', '/v1/skills/global/demo-skill');
  assert.equal(get.headers.get('etag'), '"1"');
  const body = await get.json();
  assert.equal(Object.keys(body).length, 1);
  assert.equal(body.files.length, 2);
});

test('GET /skills?scope= lists meta (name, description, scope) without file content', async () => {
  const list = await (await service.call('GET', '/v1/skills?scope=global')).json();
  const demo = list.find((s: { name: string }) => s.name === 'demo-skill');
  assert.ok(demo);
  assert.equal(demo.scope, 'global');
  assert.equal(demo.files, undefined);
});

test('the front matter name must match the URL', async () => {
  const res = await service.call('PUT', '/v1/skills/global/demo-skill', {
    body: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: skillMd('a-different-name', 'x') }] },
  });
  assert.equal(res.status, 400);
});

test('a skill needs SKILL.md at its root', async () => {
  const res = await service.call('PUT', '/v1/skills/global/no-manifest', { body: { files: [{ path: 'README.md', encoding: 'utf8', content: 'hi' }] } });
  assert.equal(res.status, 400);
});

test('paths may not escape the folder', async () => {
  const res = await service.call('PUT', '/v1/skills/global/escapee', {
    body: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: skillMd('escapee', 'x') }, { path: '../../etc/passwd', encoding: 'utf8', content: 'no' }] },
  });
  assert.equal(res.status, 400);
});

test('an oversized SKILL.md is refused', async () => {
  const res = await service.call('PUT', '/v1/skills/global/too-big', {
    body: { files: [{ path: 'SKILL.md', encoding: 'utf8', content: skillMd('too-big', 'x') + 'y'.repeat(70_000) }] },
  });
  assert.equal(res.status, 413);
});

test('a scope must be global, agent:<id> or project:<hash>', async () => {
  const res = await service.call('GET', '/v1/skills/not-a-scope/x');
  assert.equal(res.status, 400);
});

test('DELETE needs If-Match and removes the skill', async () => {
  const meta = await (await service.call('GET', '/v1/skills/global/demo-skill')).json();
  // The rev comes from the listing
  const listed = (await (await service.call('GET', '/v1/skills?scope=global')).json()).find((s: { name: string }) => s.name === 'demo-skill');
  assert.equal((await service.call('DELETE', '/v1/skills/global/demo-skill')).status, 428);
  const del = await service.call('DELETE', '/v1/skills/global/demo-skill', { headers: { 'if-match': `"${listed.rev}"` } });
  assert.equal(del.status, 200);
  assert.equal((await service.call('GET', '/v1/skills/global/demo-skill')).status, 404);
  assert.equal(meta.files.length, 2);
});

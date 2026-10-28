import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildMapRequest } from './mapgen';

test('a create request names the path, the searchable format, and the write-only rule', () => {
  const request = buildMapRequest({ path: '.tokio/map.md', exists: false, stale: [] });
  assert.match(request, /^Create an architecture map at `\.tokio\/map\.md`/);
  assert.match(request, /Keywords:/);
  assert.match(request, /- <label> -> <path>#<symbol>/);
  assert.match(request, /models, database tables/);
  assert.match(request, /Write only the map file/);
  assert.doesNotMatch(request, /no longer resolve/);
});

test('a regenerate request keeps hand-written entries and lists stale ones, capped at 20', () => {
  const stale = Array.from({ length: 23 }, (_, index) => `Auth: src/f${index}.ts not found`);
  const request = buildMapRequest({ path: '.tokio/map.md', exists: true, stale });
  assert.match(request, /^Regenerate the architecture map at `\.tokio\/map\.md`/);
  assert.match(request, /Keep areas, keywords, and notes a person wrote/);
  assert.match(request, /- Auth: src\/f0\.ts not found/);
  assert.doesNotMatch(request, /src\/f20\.ts/);
  assert.match(request, /- and 3 more/);
});

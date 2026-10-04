import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TestApp, createTestApp } from './test-app';

// Writes what this app serves under /docs into the directory named by OPENAPI_OUT (skipped otherwise): openapi.json, the Swagger UI
// page (index.html for /docs, index-slash.html for /docs/) and its initialiser (swagger-ui-init.js, which embeds the document). The other implementations of this API
// (eCommerce-node, eCommerce-dotnet) serve copies of these files at the same addresses; regenerate them with
//   OPENAPI_OUT=<directory> pnpm exec vitest run test/export-openapi.spec.ts
// (in-process, so unset API_BIN) whenever a route or its documentation changes here.
describe.skipIf(!process.env['OPENAPI_OUT'])('OpenAPI export', () => {
  let t: TestApp;
  beforeAll(async () => (t = await createTestApp()));
  afterAll(() => t.close());

  it('writes the documentation files', async () => {
    const dir = process.env['OPENAPI_OUT'] as string;
    mkdirSync(dir, { recursive: true });
    const json = await t.http().get('/docs/openapi.json');
    expect(json.status).toBe(200);
    writeFileSync(join(dir, 'openapi.json'), `${JSON.stringify(json.body, null, 2)}\n`);
    for (const [file, path] of [['index.html', '/docs'], ['index-slash.html', '/docs/'], ['swagger-ui-init.js', '/docs/swagger-ui-init.js']] as const) {
      const res = await t.http().get(path);
      expect(res.status).toBe(200);
      writeFileSync(join(dir, file), res.text);
    }
  });
});

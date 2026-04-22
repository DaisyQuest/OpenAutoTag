import test from "node:test";
import assert from "node:assert/strict";
import { createJobQueue } from "../../orchestrator/job-queue.js";
import { createAppServer } from "../../orchestrator/server.js";
import { runWorkload } from "../../orchestrator/workloads/index.js";

test("server serves the HTML-first Perfect Studio workspace", async () => {
  const queue = createJobQueue({ processor: runWorkload });
  const server = createAppServer({ queue });

  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const studioResponse = await fetch(`${baseUrl}/studio`);
    const studioHtml = await studioResponse.text();
    assert.equal(studioResponse.status, 200);
    assert.match(studioHtml, /Perfect Studio/);
    assert.match(studioHtml, /Semantic HTML/);
    assert.match(studioHtml, /PDF\/UA Readiness/);
    assert.match(studioHtml, /src="\/studio\.js\?v=html-studio"/);

    const modelResponse = await fetch(`${baseUrl}/studio-model.js`);
    const modelSource = await modelResponse.text();
    assert.equal(modelResponse.status, 200);
    assert.match(modelSource, /validateStudioHtml/);
    assert.match(modelSource, /studioTemplates/);

    const homeResponse = await fetch(baseUrl);
    const homeHtml = await homeResponse.text();
    assert.equal(homeResponse.status, 200);
    assert.match(homeHtml, /Perfect Studio/);
    assert.match(homeHtml, /Create in Perfect Studio/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

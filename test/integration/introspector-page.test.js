import test from "node:test";
import assert from "node:assert/strict";
import { createJobQueue } from "../../orchestrator/job-queue.js";
import { createAppServer } from "../../orchestrator/server.js";
import { runWorkload } from "../../orchestrator/workloads/index.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("/introspector serves the PDF introspector workspace", async () => {
  const queue = createJobQueue({ processor: runWorkload });
  const server = createAppServer({ queue });
  const baseUrl = await listen(server);

  try {
    const page = await fetch(`${baseUrl}/introspector`);
    const html = await page.text();

    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") || "", /text\/html/);
    assert.match(html, /PDF Introspector/);
    assert.match(html, /\/introspector\.js/);

    const [css, js] = await Promise.all([
      fetch(`${baseUrl}/introspector.css`),
      fetch(`${baseUrl}/introspector.js`)
    ]);

    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") || "", /text\/css/);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") || "", /application\/javascript/);
  } finally {
    await close(server);
  }
});

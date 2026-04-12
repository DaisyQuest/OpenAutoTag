import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const definitionPath = path.join(repoRoot, "test", "testing-matrix.definition.json");
const outputPath = path.join(repoRoot, "orchestrator", "public", "testing-matrix.data.json");

function collectRows(definition) {
  return definition.sections.flatMap((section) =>
    section.rows.map((row) => ({
      ...row,
      sectionId: section.id,
      sectionTitle: section.title
    }))
  );
}

function summarizeByStatus(rows, columns) {
  const counts = Object.fromEntries(columns.map((column) => [column.id, { covered: 0, partial: 0, gap: 0, na: 0 }]));

  for (const row of rows) {
    for (const column of columns) {
      const status = row.statuses?.[column.id] || "na";
      counts[column.id][status] = (counts[column.id][status] || 0) + 1;
    }
  }

  return counts;
}

function collectGaps(rows) {
  return rows
    .filter((row) => row.gap)
    .map((row) => ({
      id: row.id,
      capability: row.capability,
      module: row.module,
      priority: row.gap.priority || "medium",
      summary: row.gap.summary,
      sectionTitle: row.sectionTitle
    }));
}

async function main() {
  const definition = JSON.parse(await readFile(definitionPath, "utf8"));
  const rows = collectRows(definition);
  const output = {
    ...definition,
    generatedAt: new Date().toISOString(),
    summary: {
      sectionCount: definition.sections.length,
      rowCount: rows.length,
      columnStatusCounts: summarizeByStatus(rows, definition.columns),
      gapCount: rows.filter((row) => row.gap).length
    },
    gaps: collectGaps(rows)
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

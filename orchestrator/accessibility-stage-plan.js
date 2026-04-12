import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runJsonStage } from "./workload-runner.js";

function sortSemanticNodesForReadingOrder(semanticDocument) {
  const compareNodes = (left, right) =>
    left.pageNumber - right.pageNumber ||
    (left.columnHint || 0) - (right.columnHint || 0) ||
    left.bbox[1] - right.bbox[1] ||
    left.bbox[0] - right.bbox[0];

  const sortedNodes = [...semanticDocument.nodes].sort(compareNodes);
  const orderedNodeIds = sortedNodes.map((node, index) => {
    node.readingOrder = index;
    return node.id;
  });
  const nodesById = new Map(sortedNodes.map((node) => [node.id, node]));

  return {
    ...semanticDocument,
    nodes: semanticDocument.nodes.map((node) => nodesById.get(node.id)),
    orderedNodeIds
  };
}

async function fallbackReadingOrder(inputPath, outputPath, reason) {
  const semanticDocument = JSON.parse(await readFile(inputPath, "utf8"));
  const output = sortSemanticNodesForReadingOrder(semanticDocument);
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  return {
    outputPath: path.resolve(outputPath),
    fallbackUsed: true,
    fallbackReason: reason
  };
}

export function createAccessibilityPreparationStages({ filePath, resolvedOutputDir, artifacts }) {
  return [
    {
      key: "layout",
      label: "parser",
      outputPath: path.join(resolvedOutputDir, "01-layout.json"),
      run: async () => ({
        outputPath: await runJsonStage("modules/parser/index.js", [filePath], path.join(resolvedOutputDir, "01-layout.json")),
        artifacts: { layout: path.join(resolvedOutputDir, "01-layout.json") }
      })
    },
    {
      key: "sourceTextMap",
      label: "source-text-map",
      outputPath: path.join(resolvedOutputDir, "01b-source-text-map.json"),
      run: async () => {
        const diagnosticPath = path.join(resolvedOutputDir, "01b-source-text-map.json");

        try {
          const outputPath = await runJsonStage(
            "scripts/build-source-text-map.js",
            ["--pdf", filePath, "--layout", artifacts.layout, "--output", diagnosticPath],
            diagnosticPath
          );
          return {
            outputPath,
            artifacts: { sourceTextMap: outputPath }
          };
        } catch (error) {
          const fallbackReport = {
            status: "unavailable",
            pdfPath: path.resolve(filePath),
            layoutPath: artifacts.layout,
            error: error.message
          };
          await writeFile(diagnosticPath, `${JSON.stringify(fallbackReport, null, 2)}\n`);
          return {
            outputPath: path.resolve(diagnosticPath),
            artifacts: { sourceTextMap: path.resolve(diagnosticPath) },
            diagnosticUnavailable: true,
            diagnosticError: error.message
          };
        }
      }
    },
    {
      key: "tableStructureMap",
      label: "table-structure-map",
      outputPath: path.join(resolvedOutputDir, "01c-table-structure-map.json"),
      run: async () => {
        const diagnosticPath = path.join(resolvedOutputDir, "01c-table-structure-map.json");

        try {
          const outputPath = await runJsonStage(
            "scripts/build-table-structure-map.js",
            ["--pdf", filePath, "--layout", artifacts.layout, "--output", diagnosticPath],
            diagnosticPath
          );
          return {
            outputPath,
            artifacts: { tableStructureMap: outputPath }
          };
        } catch (error) {
          const fallbackReport = {
            schemaVersion: "1.0.0",
            status: "unavailable",
            pdfPath: path.resolve(filePath),
            layoutPath: artifacts.layout,
            pageCount: 0,
            pages: [],
            summary: {
              detectedTables: 0,
              pagesWithTables: 0,
              totalMergeSignals: 0
            },
            error: error.message
          };
          await writeFile(diagnosticPath, `${JSON.stringify(fallbackReport, null, 2)}\n`);
          return {
            outputPath: path.resolve(diagnosticPath),
            artifacts: { tableStructureMap: path.resolve(diagnosticPath) },
            diagnosticUnavailable: true,
            diagnosticError: error.message
          };
        }
      }
    },
    {
      key: "layoutEnriched",
      label: "layout-analyzer",
      outputPath: path.join(resolvedOutputDir, "02-layout-enriched.json"),
      run: async () => ({
        outputPath: await runJsonStage(
          "modules/layout-analyzer/index.js",
          [artifacts.layout, "--table-structure", artifacts.tableStructureMap],
          path.join(resolvedOutputDir, "02-layout-enriched.json")
        ),
        artifacts: { layoutEnriched: path.join(resolvedOutputDir, "02-layout-enriched.json") }
      })
    },
    {
      key: "semantic",
      label: "semantic-engine",
      outputPath: path.join(resolvedOutputDir, "03-semantic.json"),
      run: async () => ({
        outputPath: await runJsonStage("modules/semantic-engine/index.js", [artifacts.layoutEnriched], path.join(resolvedOutputDir, "03-semantic.json")),
        artifacts: { semantic: path.join(resolvedOutputDir, "03-semantic.json") }
      })
    },
    {
      key: "readingOrder",
      label: "reading-order",
      outputPath: path.join(resolvedOutputDir, "04-semantic-ordered.json"),
      run: async () => {
        const outputPath = path.join(resolvedOutputDir, "04-semantic-ordered.json");

        try {
          const stageOutputPath = await runJsonStage("modules/reading-order/index.js", [artifacts.semantic], outputPath);
          return {
            outputPath: stageOutputPath,
            artifacts: { semanticOrdered: stageOutputPath }
          };
        } catch (error) {
          const fallback = await fallbackReadingOrder(artifacts.semantic, outputPath, error.message);
          return {
            outputPath: fallback.outputPath,
            artifacts: { semanticOrdered: fallback.outputPath },
            fallbackUsed: true,
            fallbackReason: fallback.fallbackReason
          };
        }
      }
    }
  ];
}

export function createTaggingOutputStages({
  filePath,
  resolvedOutputDir,
  artifacts,
  semanticArtifactKey = "semanticOrdered",
  taggedPdfFileName = "06-tagged.pdf",
  validationReportFileName = "07-validation-report.json",
  includeValidator = true,
  writerArgs = () => []
}) {
  const stages = [
    {
      key: "tagBuilder",
      label: "tag-builder",
      outputPath: path.join(resolvedOutputDir, "05-tagging.json"),
      run: async () => ({
        outputPath: await runJsonStage(
          "modules/tag-builder/index.js",
          [artifacts[semanticArtifactKey]],
          path.join(resolvedOutputDir, "05-tagging.json")
        ),
        artifacts: { tagging: path.join(resolvedOutputDir, "05-tagging.json") }
      })
    },
    {
      key: "pdfWriter",
      label: "pdf-writer",
      outputPath: path.join(resolvedOutputDir, taggedPdfFileName),
      run: async () => {
        const taggedPdf = path.join(resolvedOutputDir, taggedPdfFileName);
        const writerReportPath = path.join(resolvedOutputDir, "06-writer-report.json");
        const extraArgs = writerArgs({ artifacts, resolvedOutputDir }) || [];
        const writerReport = await runJsonStage(
          "modules/pdf-writer/index.js",
          ["--pdf", filePath, "--tags", artifacts.tagging, "--semantic", artifacts[semanticArtifactKey], "--output", taggedPdf, ...extraArgs],
          writerReportPath
        );
        return {
          outputPath: taggedPdf,
          artifacts: {
            taggedPdf,
            writerReport,
            tagManifest: path.resolve(`${taggedPdf}.tags.json`)
          }
        };
      }
    },
    {
      key: "tagDeltaReport",
      label: "tag-delta-report",
      outputPath: path.join(resolvedOutputDir, "06b-tag-delta-report.json"),
      run: async () => {
        const outputPath = path.join(resolvedOutputDir, "06b-tag-delta-report.json");
        return {
          outputPath: await runJsonStage(
            "scripts/build-tag-delta-report.js",
            ["--source-pdf", filePath, "--tagged-pdf", artifacts.taggedPdf, "--output", outputPath],
            outputPath
          ),
          artifacts: { tagDeltaReport: outputPath }
        };
      }
    }
  ];

  if (includeValidator) {
    stages.push({
      key: "validator",
      label: "validator",
      outputPath: path.join(resolvedOutputDir, validationReportFileName),
      run: async () => ({
        outputPath: await runJsonStage(
          "modules/validator/index.js",
          ["--pdf", artifacts.taggedPdf, "--manifest", artifacts.tagManifest],
          path.join(resolvedOutputDir, validationReportFileName)
        ),
        artifacts: { validationReport: path.join(resolvedOutputDir, validationReportFileName) }
      })
    });
  }

  return stages;
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { sampleCorpus, runProfile, scoreJob, diffRuns } from "./lib/tools.js";

export { sampleCorpus, runProfile, scoreJob, diffRuns };

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------
function createServer() {
  const server = new McpServer(
    { name: "corpus-eval", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.tool(
    "sample_corpus",
    "Sample PDFs from a corpus directory with optional filtering criteria",
    {
      directory: z.string().optional().describe("Directory containing PDFs (default: C:\\LRBTest)"),
      n: z.number().int().positive().optional().describe("Number of samples to return"),
      criteria: z.object({
        minPages: z.number().int().optional().describe("Minimum page count"),
        maxPages: z.number().int().optional().describe("Maximum page count"),
        hasOcr: z.boolean().optional().describe("Filter for OCR-containing PDFs (advisory only)"),
        namePattern: z.string().optional().describe("Regex pattern to match file names")
      }).optional().describe("Filtering criteria")
    },
    async (args) => {
      const result = await sampleCorpus(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "run_profile",
    "Run the full accessibility pipeline for each PDF using a specified profile",
    {
      profileId: z.string().describe("Profile ID to use for the pipeline run"),
      profileOverrides: z.record(z.unknown()).optional().describe("Profile override settings"),
      pdfPaths: z.array(z.string()).describe("Array of PDF file paths to process"),
      outputDir: z.string().optional().describe("Output directory for the run")
    },
    async (args) => {
      const result = await runProfile(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "score_job",
    "Score a completed pipeline job by reading its artifacts and computing quality metrics",
    {
      jobDir: z.string().describe("Path to the job output directory")
    },
    async (args) => {
      const result = await scoreJob(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "diff_runs",
    "Compare two evaluation run directories and compute per-PDF and aggregate score deltas",
    {
      runADir: z.string().describe("Path to the first (baseline) run directory"),
      runBDir: z.string().describe("Path to the second (comparison) run directory")
    },
    async (args) => {
      const result = await diffRuns(args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

export { createServer };

// Start server on stdio only when run directly
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

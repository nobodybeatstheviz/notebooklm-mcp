import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  listNotebooks,
  createNotebook,
  deleteNotebook,
  listSources,
  addTextSource,
  addUrlSource,
  deleteSource,
  queryNotebook,
  generateAudio,
  getAuthStatus,
} from "./notebooklm.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "notebooklm_auth_status",
    description: "Check whether the MCP server is authenticated with NotebookLM.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "notebooklm_list_notebooks",
    description: "List all NotebookLM notebooks (projects) in the authenticated account.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "notebooklm_create_notebook",
    description: "Create a new NotebookLM notebook.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Title for the new notebook." },
      },
      required: ["title"],
    },
  },
  {
    name: "notebooklm_delete_notebook",
    description: "Permanently delete a NotebookLM notebook.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string", description: "ID of the notebook to delete." },
      },
      required: ["notebook_id"],
    },
  },
  {
    name: "notebooklm_list_sources",
    description: "List all sources in a notebook.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string", description: "ID of the notebook." },
      },
      required: ["notebook_id"],
    },
  },
  {
    name: "notebooklm_add_text_source",
    description: "Add a plain-text document as a source in a notebook.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string", description: "ID of the notebook." },
        title: { type: "string", description: "Display title for the source." },
        content: { type: "string", description: "Full text content of the document." },
      },
      required: ["notebook_id", "title", "content"],
    },
  },
  {
    name: "notebooklm_add_url_source",
    description: "Add a web URL as a source in a notebook (NotebookLM will fetch and index it).",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string", description: "ID of the notebook." },
        url: { type: "string", description: "URL to add as a source." },
      },
      required: ["notebook_id", "url"],
    },
  },
  {
    name: "notebooklm_delete_source",
    description: "Remove a source from a notebook.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string", description: "ID of the notebook." },
        source_id: { type: "string", description: "ID of the source to remove." },
      },
      required: ["notebook_id", "source_id"],
    },
  },
  {
    name: "notebooklm_query",
    description:
      "Ask a question against a notebook's sources. Returns a grounded answer with citations.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string", description: "ID of the notebook." },
        query: { type: "string", description: "The question or prompt to send." },
      },
      required: ["notebook_id", "query"],
    },
  },
  {
    name: "notebooklm_generate_audio",
    description:
      "Trigger generation of a podcast-style Audio Overview for a notebook. " +
      "Returns a status object; poll or wait for status=completed to get the audio URL.",
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string", description: "ID of the notebook." },
      },
      required: ["notebook_id"],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createMcpServer(): Server {
  const server = new Server(
    { name: "notebooklm-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      let result: unknown;

      switch (name) {
        case "notebooklm_auth_status":
          result = await getAuthStatus();
          break;

        case "notebooklm_list_notebooks":
          result = await listNotebooks();
          break;

        case "notebooklm_create_notebook": {
          const { title } = args as { title: string };
          result = await createNotebook(title);
          break;
        }

        case "notebooklm_delete_notebook": {
          const { notebook_id } = args as { notebook_id: string };
          await deleteNotebook(notebook_id);
          result = { deleted: true, notebook_id };
          break;
        }

        case "notebooklm_list_sources": {
          const { notebook_id } = args as { notebook_id: string };
          result = await listSources(notebook_id);
          break;
        }

        case "notebooklm_add_text_source": {
          const { notebook_id, title, content } = args as {
            notebook_id: string;
            title: string;
            content: string;
          };
          result = await addTextSource(notebook_id, title, content);
          break;
        }

        case "notebooklm_add_url_source": {
          const { notebook_id, url } = args as {
            notebook_id: string;
            url: string;
          };
          result = await addUrlSource(notebook_id, url);
          break;
        }

        case "notebooklm_delete_source": {
          const { notebook_id, source_id } = args as {
            notebook_id: string;
            source_id: string;
          };
          await deleteSource(notebook_id, source_id);
          result = { deleted: true, source_id };
          break;
        }

        case "notebooklm_query": {
          const { notebook_id, query } = args as {
            notebook_id: string;
            query: string;
          };
          result = await queryNotebook(notebook_id, query);
          break;
        }

        case "notebooklm_generate_audio": {
          const { notebook_id } = args as { notebook_id: string };
          result = await generateAudio(notebook_id);
          break;
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

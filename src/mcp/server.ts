import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MlsError, toMlsError } from '../errors.js';
import type { Logger } from '../logging.js';
import { nullLogger } from '../logging.js';
import type { MlsService } from '../service/mls-service.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';
import type { ToolDefinition } from './tools.js';
import { buildTools } from './tools.js';

/** Hard ceiling on a single serialized tool response, to bound memory and context. */
export const MAX_RESPONSE_BYTES = 1_500_000;

export interface ToolOutcome {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Execute a tool handler and shape the result. Errors are mapped to a stable
 * structured payload; secrets are stripped by MlsError/redactSecrets before
 * anything reaches the client or the log.
 */
export async function runTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  logger: Logger = nullLogger
): Promise<ToolOutcome> {
  try {
    const result = await tool.handler(args);
    const text = JSON.stringify(result, null, 2);
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new MlsError(
        'VALIDATION',
        `Response exceeds the ${MAX_RESPONSE_BYTES}-byte bound (${text.length} bytes). Narrow the query — ` +
          'tighter geography, status, price or date bounds, or a smaller limit.',
        { details: { tool: tool.name, bytes: text.length } }
      );
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const mlsErr = toMlsError(err);
    // Log the code and tool only. Never log arguments or upstream payloads,
    // which can carry confidential MLS content.
    logger.error('tool call failed', { tool: tool.name, code: mlsErr.code });
    return {
      content: [{ type: 'text', text: JSON.stringify(mlsErr.toJSON(), null, 2) }],
      isError: true
    };
  }
}

export function createMcpServer(service: MlsService, logger: Logger = nullLogger): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Read-only NorthstarMLS intelligence. Every tool is read-only: this server has no MLS add/edit surface. ' +
        'Call get_capabilities before relying on address lookup, listing history, or media. Collection results ' +
        'carry _completeness metadata — never present a result whose completeness_status is not "complete" as a ' +
        'market total. Statistics are computed from retrieved records with stated methodology; comparables are ' +
        'ranked evidence, not an opinion of value.'
    }
  );

  for (const tool of buildTools(service)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true
        }
      },
      // The SDK's generic callback type does not narrow to our handler shape.
      (async (args: Record<string, unknown>) =>
        runTool(tool, args ?? {}, logger)) as never
    );
  }

  return server;
}

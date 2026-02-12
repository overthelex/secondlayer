/**
 * Base Tool Handler - Abstract base class for all MCP tool handlers
 *
 * Provides unified interface for tool definitions, execution, and response formatting.
 * All domain tool handlers must extend this class.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, any>; required?: string[] };
}

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export type StreamEventCallback = (event: {
  type: string;
  data: any;
  id?: string;
}) => void;

export abstract class BaseToolHandler {
  /**
   * Return all tool definitions this handler provides.
   */
  abstract getToolDefinitions(): ToolDefinition[];

  /**
   * Execute a tool by name. Returns null if the tool is not handled by this handler.
   */
  abstract executeTool(name: string, args: any): Promise<ToolResult | null>;

  /**
   * Optional streaming execution for tools that support SSE streaming.
   * Returns false if the tool doesn't support streaming.
   */
  async executeToolStream?(name: string, args: any, callback: StreamEventCallback): Promise<ToolResult | null>;

  /**
   * Check if this handler can handle the given tool name.
   */
  handles(name: string): boolean {
    return this.getToolDefinitions().some(t => t.name === name);
  }

  /**
   * Wrap any data into a standard ToolResult.
   */
  protected wrapResponse(data: any): ToolResult {
    return {
      content: [{
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      }],
    };
  }

  /**
   * Wrap an error message into a standard ToolResult with isError flag.
   */
  protected wrapError(message: string): ToolResult {
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}

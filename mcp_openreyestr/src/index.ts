#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import {
  OpenReyestrTools,
  SearchEntitiesSchema,
  GetEntityDetailsSchema,
  SearchBeneficiariesSchema,
  GetByEdrpouSchema,
} from './api/openreyestr-tools.js';

dotenv.config();

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5435'),
  user: process.env.POSTGRES_USER || 'openreyestr',
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB || 'openreyestr',
});

const tools = new OpenReyestrTools(pool);

const server = new Server(
  {
    name: 'openreyestr-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'search_entities',
        description:
          'Search for entities in the Ukrainian State Register (OPENREYESTR) by name, EDRPOU code, record number, or status. Can search legal entities (UO), individual entrepreneurs (FOP), public associations (FSU), or all types.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query (name or partial name of entity)',
            },
            edrpou: {
              type: 'string',
              description: 'EDRPOU identification code',
            },
            record: {
              type: 'string',
              description: 'Registry record number',
            },
            entityType: {
              type: 'string',
              enum: ['UO', 'FOP', 'FSU', 'ALL'],
              description:
                'Type of entity: UO (legal entities), FOP (individual entrepreneurs), FSU (public associations), ALL (all types)',
              default: 'ALL',
            },
            stan: {
              type: 'string',
              description: 'Status of entity (e.g., "зареєстровано", "припинено")',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results (1-100)',
              default: 50,
            },
            offset: {
              type: 'number',
              description: 'Offset for pagination',
              default: 0,
            },
          },
        },
      },
      {
        name: 'get_entity_details',
        description:
          'Get full details of an entity including founders, beneficiaries, signers, branches, and all related information.',
        inputSchema: {
          type: 'object',
          properties: {
            record: {
              type: 'string',
              description: 'Registry record number of the entity',
            },
            entityType: {
              type: 'string',
              enum: ['UO', 'FOP', 'FSU'],
              description:
                'Type of entity (optional, will be auto-detected if not provided)',
            },
          },
          required: ['record'],
        },
      },
      {
        name: 'search_beneficiaries',
        description:
          'Search for beneficial owners (beneficiaries) by name across all entities in the registry.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Name or partial name of beneficiary to search for',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results (1-100)',
              default: 50,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_by_edrpou',
        description: 'Get entity information by EDRPOU identification code.',
        inputSchema: {
          type: 'object',
          properties: {
            edrpou: {
              type: 'string',
              description: 'EDRPOU identification code',
            },
          },
          required: ['edrpou'],
        },
      },
      {
        name: 'get_statistics',
        description:
          'Get registry statistics including total number of entities, active entities, and breakdown by type.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'search_entities': {
        const params = SearchEntitiesSchema.parse(args);
        const results = await tools.searchEntities(params);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case 'get_entity_details': {
        const params = GetEntityDetailsSchema.parse(args);
        const details = await tools.getEntityDetails(params.record, params.entityType);
        if (!details) {
          return {
            content: [
              {
                type: 'text',
                text: 'Entity not found',
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(details, null, 2),
            },
          ],
        };
      }

      case 'search_beneficiaries': {
        const params = SearchBeneficiariesSchema.parse(args);
        const results = await tools.searchBeneficiaries(params.query, params.limit);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }

      case 'get_by_edrpou': {
        const params = GetByEdrpouSchema.parse(args);
        const entity = await tools.getByEdrpou(params.edrpou);
        if (!entity) {
          return {
            content: [
              {
                type: 'text',
                text: 'Entity not found',
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(entity, null, 2),
            },
          ],
        };
      }

      case 'get_statistics': {
        const stats = await tools.getStatistics();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: 'text',
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('OPENREYESTR MCP Server running on stdio');
}

runServer().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});

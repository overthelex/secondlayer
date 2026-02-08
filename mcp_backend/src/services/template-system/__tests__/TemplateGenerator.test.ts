/**
 * TemplateGenerator Unit Tests
 *
 * Comprehensive testing of template generation, validation, and sampling
 */

import { TemplateGenerator } from '../TemplateGenerator';
import { QuestionClassification, TemplateGenerationRequest } from '../types';

// Mock database
const mockDb = {
  query: jest.fn(),
};

// Mock LLM Manager
const mockLlmManager = {
  generateText: jest.fn(),
};

// Mock cost tracker
const mockCostTracker = {
  track: jest.fn(),
};

const mockClassification: QuestionClassification = {
  intent: 'contract termination',
  confidence: 0.95,
  category: 'labor_law',
  entities: {
    dates: [],
    amounts: [],
    names: [],
    emails: [],
    phones: [],
    percentages: [],
  },
  keywords: ['contract', 'termination', 'labor'],
  reasoning: 'Question is about employment contract termination',
  alternatives: [],
  executionTimeMs: 450,
  costUsd: 0.002,
};

describe('TemplateGenerator', () => {
  let generator: TemplateGenerator;

  beforeEach(() => {
    jest.clearAllMocks();
    generator = new TemplateGenerator(
      mockDb as any,
      mockLlmManager,
      mockCostTracker
    );
  });

  // ====== Tests for Mustache syntax validation ======

  describe('Mustache Syntax Validation', () => {
    test('should validate correct Mustache syntax', () => {
      const template =
        'Employment agreement for {{employee_name}} dated {{contract_date}}.';
      const isValid = (generator as any).validateMustacheSyntax(template);
      expect(isValid).toBe(true);
    });

    test('should reject unbalanced opening brackets', () => {
      const template =
        'Employment agreement for {{employee_name} dated {{contract_date}}.';
      const isValid = (generator as any).validateMustacheSyntax(template);
      expect(isValid).toBe(false);
    });

    test('should reject unbalanced closing brackets', () => {
      const template =
        'Employment agreement for {{employee_name}} dated {contract_date}}.';
      const isValid = (generator as any).validateMustacheSyntax(template);
      expect(isValid).toBe(false);
    });

    test('should handle nested brackets correctly', () => {
      const template =
        'Employee: {{employee.name}}, Position: {{employee.position}}';
      const isValid = (generator as any).validateMustacheSyntax(template);
      expect(isValid).toBe(true);
    });

    test('should handle empty template', () => {
      const template = '';
      const isValid = (generator as any).validateMustacheSyntax(template);
      expect(isValid).toBe(true);
    });

    test('should handle template with no variables', () => {
      const template =
        'This is a standard employment contract with no variables.';
      const isValid = (generator as any).validateMustacheSyntax(template);
      expect(isValid).toBe(true);
    });
  });

  // ====== Tests for Mustache variable extraction ======

  describe('Mustache Variable Extraction', () => {
    test('should extract single variable', () => {
      const template = 'Employee name: {{employee_name}}';
      const vars = (generator as any).extractMustacheVariables(template);
      expect(vars).toEqual(['employee_name']);
    });

    test('should extract multiple variables', () => {
      const template =
        'Employee {{name}} works in {{department}} since {{start_date}}.';
      const vars = (generator as any).extractMustacheVariables(template);
      expect(vars).toEqual(['name', 'department', 'start_date']);
    });

    test('should handle duplicate variables (return unique)', () => {
      const template =
        'Employee {{name}} authorized by {{manager}}. Name: {{name}}';
      const vars = (generator as any).extractMustacheVariables(template);
      expect(vars).toEqual(['name', 'manager']);
    });

    test('should handle variables with spaces', () => {
      const template = 'Amount: {{ contract_amount }} EUR';
      const vars = (generator as any).extractMustacheVariables(template);
      expect(vars).toEqual(['contract_amount']);
    });

    test('should return empty array for template with no variables', () => {
      const template = 'This is a static template.';
      const vars = (generator as any).extractMustacheVariables(template);
      expect(vars).toEqual([]);
    });
  });

  // ====== Tests for JSON schema validation ======

  describe('JSON Schema Validation', () => {
    test('should validate correct input schema', () => {
      const inputSchema = {
        type: 'object',
        properties: {
          employee_name: { type: 'string' },
          contract_date: { type: 'string' },
        },
        required: ['employee_name', 'contract_date'],
      };
      const outputSchema = {
        type: 'object',
        properties: {
          result: { type: 'string' },
        },
      };
      const isValid = (generator as any).validateSchemas(
        inputSchema,
        outputSchema
      );
      expect(isValid).toBe(true);
    });

    test('should reject schema with missing type', () => {
      const inputSchema = {
        properties: {
          employee_name: { type: 'string' },
        },
      };
      const outputSchema = {
        type: 'object',
        properties: { result: { type: 'string' } },
      };
      const isValid = (generator as any).validateSchemas(
        inputSchema,
        outputSchema
      );
      expect(isValid).toBe(false);
    });

    test('should reject schema with missing properties', () => {
      const inputSchema = {
        type: 'object',
      };
      const outputSchema = {
        type: 'object',
        properties: { result: { type: 'string' } },
      };
      const isValid = (generator as any).validateSchemas(
        inputSchema,
        outputSchema
      );
      expect(isValid).toBe(false);
    });

    test('should reject null schema', () => {
      const isValid = (generator as any).validateSchemas(null, null);
      expect(isValid).toBe(false);
    });

    test('should reject non-object type', () => {
      const inputSchema = {
        type: 'array',
        items: { type: 'string' },
      };
      const outputSchema = {
        type: 'object',
        properties: { result: { type: 'string' } },
      };
      const isValid = (generator as any).validateSchemas(
        inputSchema,
        outputSchema
      );
      expect(isValid).toBe(false);
    });
  });

  // ====== Tests for template rendering ======

  describe('Mustache Template Rendering', () => {
    test('should render template with single variable', () => {
      const template = 'Employee: {{name}}';
      const data = { name: 'John Doe' };
      const result = (generator as any).renderMustacheTemplate(template, data);
      expect(result).toBe('Employee: John Doe');
    });

    test('should render template with multiple variables', () => {
      const template =
        'Employee {{name}} in {{department}} since {{date}}.';
      const data = {
        name: 'Jane Smith',
        department: 'Legal',
        date: '2023-01-15',
      };
      const result = (generator as any).renderMustacheTemplate(template, data);
      expect(result).toBe(
        'Employee Jane Smith in Legal since 2023-01-15.'
      );
    });

    test('should handle unused variables', () => {
      const template = 'Name: {{name}}, Title: {{title}}';
      const data = { name: 'John', title: 'Manager', unused: 'data' };
      const result = (generator as any).renderMustacheTemplate(template, data);
      expect(result).toBe('Name: John, Title: Manager');
    });

    test('should convert number values to strings', () => {
      const template = 'Salary: {{amount}} EUR';
      const data = { amount: 50000 };
      const result = (generator as any).renderMustacheTemplate(template, data);
      expect(result).toBe('Salary: 50000 EUR');
    });

    test('should convert boolean values to strings', () => {
      const template = 'Full-time: {{is_fulltime}}';
      const data = { is_fulltime: true };
      const result = (generator as any).renderMustacheTemplate(template, data);
      expect(result).toBe('Full-time: true');
    });

    test('should handle template with no variables', () => {
      const template = 'This is a static template.';
      const data = {};
      const result = (generator as any).renderMustacheTemplate(template, data);
      expect(result).toBe('This is a static template.');
    });
  });

  // ====== Tests for LLM response parsing ======

  describe('LLM Response Parsing', () => {
    test('should parse valid JSON response with code fence', () => {
      const response = `\`\`\`json
{
  "name": "Contract Termination",
  "description": "Template for employment termination",
  "category": "labor_law",
  "intent": "contract_termination",
  "promptTemplate": "Terminate {{employee_name}}'s contract.",
  "inputSchema": {"type": "object", "properties": {"employee_name": {"type": "string"}}},
  "outputSchema": {"type": "object", "properties": {"result": {"type": "string"}}},
  "examples": [{"employee_name": "John Doe"}]
}
\`\`\``;

      const template = (generator as any).parseTemplateResponse(response);
      expect(template.name).toBe('Contract Termination');
      expect(template.category).toBe('labor_law');
      expect(template.examples.length).toBe(1);
    });

    test('should parse JSON without code fence', () => {
      const response = `{
  "name": "Termination",
  "description": "Template",
  "category": "labor_law",
  "intent": "termination",
  "promptTemplate": "Terminate {{name}}",
  "inputSchema": {"type": "object", "properties": {}},
  "outputSchema": {"type": "object", "properties": {}},
  "examples": []
}`;

      const template = (generator as any).parseTemplateResponse(response);
      expect(template.name).toBe('Termination');
    });

    test('should throw error on invalid JSON', () => {
      const response = `{ invalid json }`;
      expect(() => {
        (generator as any).parseTemplateResponse(response);
      }).toThrow('Failed to parse template from LLM response');
    });

    test('should extract JSON from markdown code fence', () => {
      const response = `Here is your template:
\`\`\`json
{"name": "Test", "category": "labor_law", "intent": "test", "promptTemplate": "Test {{x}}", "inputSchema": {"type":"object","properties":{}}, "outputSchema": {"type":"object","properties":{}}, "examples": []}
\`\`\``;

      const template = (generator as any).parseTemplateResponse(response);
      expect(template.name).toBe('Test');
    });
  });

  // ====== Tests for template validation ======

  describe('Template Validation', () => {
    test('should validate correct template', async () => {
      const template = {
        name: 'Termination',
        description: 'Employment termination',
        category: 'labor_law',
        intent: 'termination',
        promptTemplate: 'Employee {{name}} contract terminated {{date}}.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            date: { type: 'string' },
          },
          required: ['name', 'date'],
        },
        outputSchema: {
          type: 'object',
          properties: { result: { type: 'string' } },
        },
        examples: [{ name: 'John', date: '2024-01-01' }],
      };

      const result = await (generator as any).validateTemplate(template);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('should detect syntax errors', async () => {
      const template = {
        name: 'Bad',
        description: 'Bad template',
        category: 'labor_law',
        intent: 'test',
        promptTemplate: 'Employee {{name} not closed.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
        outputSchema: {
          type: 'object',
          properties: { result: { type: 'string' } },
        },
        examples: [],
      };

      const result = await (generator as any).validateTemplate(template);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    test('should warn about undefined variables', async () => {
      const template = {
        name: 'Test',
        description: 'Test',
        category: 'labor_law',
        intent: 'test',
        promptTemplate: 'Name: {{name}}, Age: {{age}}',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
        outputSchema: {
          type: 'object',
          properties: { result: { type: 'string' } },
        },
        examples: [],
      };

      const result = await (generator as any).validateTemplate(template);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('undefined variables');
    });
  });

  // ====== Tests for test input generation ======

  describe('Test Input Generation', () => {
    test('should generate test inputs from schema', () => {
      const template = {
        name: 'Test',
        description: 'Test',
        category: 'labor_law',
        intent: 'test',
        promptTemplate: 'Test {{name}} {{amount}} {{active}}',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            amount: { type: 'number' },
            active: { type: 'boolean' },
          },
        },
        outputSchema: {
          type: 'object',
          properties: { result: { type: 'string' } },
        },
        examples: [],
      };

      const inputs = (generator as any).generateTestInputs(template);
      expect(inputs).toHaveLength(5);
      expect(inputs[0]).toHaveProperty('name');
      expect(inputs[0]).toHaveProperty('amount');
      expect(inputs[0]).toHaveProperty('active');
    });

    test('should generate appropriate types for test inputs', () => {
      const template = {
        name: 'Test',
        description: 'Test',
        category: 'labor_law',
        intent: 'test',
        promptTemplate: 'Test',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            number: { type: 'number' },
            flag: { type: 'boolean' },
          },
        },
        outputSchema: {
          type: 'object',
          properties: { result: { type: 'string' } },
        },
        examples: [],
      };

      const inputs = (generator as any).generateTestInputs(template);
      expect(typeof inputs[0].text).toBe('string');
      expect(typeof inputs[0].number).toBe('number');
      expect(typeof inputs[0].flag).toBe('boolean');
    });
  });

  // ====== Tests for sampling tests ======

  describe('Sampling Tests', () => {
    test('should run sampling tests successfully', async () => {
      const template = {
        name: 'Test',
        description: 'Test',
        category: 'labor_law',
        intent: 'test',
        promptTemplate: 'Employee {{name}}',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
        outputSchema: {
          type: 'object',
          properties: { result: { type: 'string' } },
        },
        examples: [{ name: 'John' }, { name: 'Jane' }],
      };

      const results = await (generator as any).runSamplingTests(template);
      expect(results).toHaveLength(2);
      expect(results[0]).toHaveProperty('success');
      expect(results[0]).toHaveProperty('output');
      expect(results[0]).toHaveProperty('latencyMs');
    });

    test('should mark test as failed on error', async () => {
      const template = {
        name: 'Test',
        description: 'Test',
        category: 'labor_law',
        intent: 'test',
        promptTemplate: 'Invalid {{undefined}}',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        outputSchema: {
          type: 'object',
          properties: { result: { type: 'string' } },
        },
        examples: [{}],
      };

      const results = await (generator as any).runSamplingTests(template);
      expect(results[0].success).toBe(false);
    });
  });

  // ====== Tests for approval workflow ======

  describe('Approval Workflow', () => {
    test('should approve generation and create template', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          {
            template: {
              name: 'Test',
              category: 'labor_law',
              intent: 'test',
              promptTemplate: 'Test',
              inputSchema: {},
              outputSchema: {},
            },
          },
        ],
      });
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'test' }] });
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'test' }] });

      const result = await generator.approveGeneration(
        'gen123',
        'Good template'
      );
      expect(result.status).toBe('approved');
      expect(result.templateId).toBeDefined();
    });

    test('should reject generation', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [],
      });

      try {
        await generator.rejectGeneration('gen123', 'Poor quality');
      } catch (error) {
        // Expected to fail
      }

      // Second attempt should fail gracefully
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'test' }] });
      const result = await generator.rejectGeneration(
        'gen123',
        'Not suitable'
      );
      expect(result.status).toBe('rejected');
    });
  });

  // ====== Tests for edge cases ======

  describe('Edge Cases', () => {
    test('should handle very long template', () => {
      const longTemplate = 'A'.repeat(10000) + ' {{var}}';
      const isValid = (generator as any).validateMustacheSyntax(longTemplate);
      expect(isValid).toBe(true);
    });

    test('should handle special characters in values', () => {
      const template = 'Text: {{text}}';
      const data = {
        text: 'Special chars: !@#$%^&*()_+-=[]{}|;:,.<>?',
      };
      const result = (generator as any).renderMustacheTemplate(template, data);
      expect(result).toContain('Special chars');
    });

    test('should handle unicode characters', () => {
      const template = 'Name: {{name}}, Category: {{category}}';
      const data = { name: 'Йван', category: 'Правовая' };
      const result = (generator as any).renderMustacheTemplate(template, data);
      expect(result).toBe('Name: Йван, Category: Правовая');
    });

    test('should handle whitespace in variables', () => {
      const template = 'Text: {{ variable_name }} here';
      const vars = (generator as any).extractMustacheVariables(template);
      expect(vars).toEqual(['variable_name']);
    });
  });
});

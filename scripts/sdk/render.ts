/**
 * Website API SDK generation (S7-03, ADR 0012 #7): feed-api's OpenAPI (operations tagged `website-v2`) → the
 * committed `packages/sdk/openapi.json` and the typed operation table `packages/sdk/src/generated.ts`. Dependency-free:
 * the JSON Schemas the Zod type provider emits use a small subset (objects, arrays, enums, unions, nullable), which
 * `typeOf` turns into TypeScript. Pure functions; `generate.ts` runs them.
 */

type Schema = Record<string, unknown>;
interface Parameter {
  in: 'query' | 'path' | 'header';
  name: string;
  required?: boolean;
  schema: Schema;
  description?: string;
}
interface Operation {
  operationId: string;
  summary?: string;
  tags?: string[];
  parameters?: Parameter[];
  /** S7-05: website forms post JSON bodies. */
  requestBody?: { required?: boolean; content?: Record<string, { schema: Schema }> };
  responses: Record<string, { content?: Record<string, { schema: Schema }> }>;
}
export interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
}

export const SDK_TAG = 'website-v2';

/** Sorted keys, two-space indent, final newline: the committed form. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Only the website API v2 operations (and the component schemas they use). */
export function websiteSpec(doc: OpenApiDoc): OpenApiDoc {
  const paths: OpenApiDoc['paths'] = {};
  for (const [path, ops] of Object.entries(doc.paths)) {
    const kept = Object.fromEntries(Object.entries(ops).filter(([, op]) => op.tags?.includes(SDK_TAG)));
    if (Object.keys(kept).length > 0) paths[path] = kept;
  }
  return {
    openapi: doc.openapi,
    info: doc.info,
    paths,
    ...(doc.components?.schemas && Object.keys(doc.components.schemas).length > 0
      ? { components: { schemas: doc.components.schemas } }
      : {}),
  };
}

export const renderJson = (spec: OpenApiDoc): string => `${JSON.stringify(stable(spec), null, 2)}\n`;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
const pascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A JSON Schema (the subset the server emits) as a TypeScript type. */
export function typeOf(s: Schema, indent = ''): string {
  const inner = `${indent}  `;
  let t: string;
  if (typeof s.$ref === 'string') {
    t = pascal(s.$ref.split('/').pop() as string);
  } else if ('const' in s) {
    t = JSON.stringify(s.const);
  } else if (Array.isArray(s.enum)) {
    t = s.enum.map((v) => JSON.stringify(v)).join(' | ');
  } else if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const parts = [...new Set(((s.anyOf ?? s.oneOf) as Schema[]).map((x) => typeOf(x, indent)))];
    t = parts.length === 1 ? (parts[0] as string) : parts.map((p) => (p.includes('\n') ? `(${p})` : p)).join(' | ');
  } else {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string | undefined];
    const one = (type: string | undefined): string => {
      switch (type) {
        case 'string':
          return 'string';
        case 'integer':
        case 'number':
          return 'number';
        case 'boolean':
          return 'boolean';
        case 'null':
          return 'null';
        case 'array': {
          const items = s.items ? typeOf(s.items as Schema, indent) : 'unknown';
          return /[|&\n]/.test(items) ? `Array<${items}>` : `${items}[]`;
        }
        case 'object':
        case undefined: {
          const props = (s.properties ?? {}) as Record<string, Schema>;
          const required = new Set((s.required ?? []) as string[]);
          const names = Object.keys(props);
          const extra = s.additionalProperties;
          if (names.length === 0) {
            if (extra && typeof extra === 'object') return `Record<string, ${typeOf(extra as Schema, indent)}>`;
            return type === 'object' ? 'Record<string, unknown>' : 'unknown';
          }
          const lines = names.map((n) => {
            const p = props[n] as Schema;
            const doc =
              typeof p.description === 'string' ? `${inner}/** ${p.description.replace(/\*\//g, '* /')} */\n` : '';
            return `${doc}${inner}${key(n)}${required.has(n) ? '' : '?'}: ${typeOf(p, inner)};`;
          });
          return `{\n${lines.join('\n')}\n${indent}}`;
        }
        default:
          return 'unknown';
      }
    };
    t = types.map(one).join(' | ');
  }
  return s.nullable === true && t !== 'unknown' ? `${t} | null` : t;
}

/** `websiteV2.listListings` → `listListings`. */
const methodName = (operationId: string) => operationId.split('.').pop() as string;

/** The typed operation table and convenience methods. */
export function renderTs(spec: OpenApiDoc): string {
  const out: string[] = [
    "// Generated by `pnpm sdk:generate` from feed-api's OpenAPI (operations tagged website-v2). Do not edit.",
    '',
  ];
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`export type ${pascal(name)} = ${typeOf(schema)};`, '');
  }
  const table: string[] = [];
  const types: string[] = [];
  const methods: string[] = [];
  const ops = Object.entries(spec.paths)
    .flatMap(([path, byMethod]) => Object.entries(byMethod).map(([method, op]) => ({ path, method, op })))
    .sort((a, b) => a.op.operationId.localeCompare(b.op.operationId));
  for (const { path, method, op } of ops) {
    const name = methodName(op.operationId);
    const T = pascal(name);
    const params = op.parameters ?? [];
    const group = (where: Parameter['in']) => {
      const ps = params.filter((p) => p.in === where);
      if (ps.length === 0) return 'Record<string, never>';
      return `{\n${ps
        .map((p) => `  ${key(p.name)}${p.required ? '' : '?'}: ${typeOf(p.schema, '  ')};`)
        .join('\n')}\n}`;
    };
    // A created resource answers 201 (S7-05), a read 200: the same body type either way.
    const response = (op.responses['200'] ?? op.responses['201'])?.content?.['application/json']?.schema;
    const body = op.requestBody?.content?.['application/json']?.schema;
    if (op.summary) out.push(`/** ${op.summary.replace(/\*\//g, '* /')} */`);
    out.push(`export type ${T}Params = ${group('path')};`);
    out.push(`export type ${T}Query = ${group('query')};`);
    if (body) {
      out.push(`export type ${T}Body = ${typeOf(body)};`);
      out.push(`export type ${T}Headers = ${group('header')};`);
    }
    out.push(`export type ${T}Response = ${response ? typeOf(response) : 'void'};`, '');
    table.push(`  ${name}: { method: ${JSON.stringify(method.toUpperCase())}, path: ${JSON.stringify(path)} },`);
    types.push(
      body
        ? `  ${name}: { params: ${T}Params; query: ${T}Query; body: ${T}Body; headers: ${T}Headers; response: ${T}Response };`
        : `  ${name}: { params: ${T}Params; query: ${T}Query; body?: never; headers?: never; response: ${T}Response };`,
    );
    const pathParams = params.some((p) => p.in === 'path');
    const queryRequired = params.some((p) => p.in === 'query' && p.required);
    if (body) {
      const args = pathParams
        ? `params: ${T}Params, body: ${T}Body, headers: ${T}Headers`
        : `body: ${T}Body, headers: ${T}Headers`;
      methods.push(`    ${name}: (${args}) => call('${name}', { ${pathParams ? 'params, ' : ''}body, headers }),`);
      continue;
    }
    const args = pathParams
      ? `params: ${T}Params, query${queryRequired ? '' : '?'}: ${T}Query`
      : `query${queryRequired ? '' : '?'}: ${T}Query`;
    methods.push(`    ${name}: (${args}) => call('${name}', { ${pathParams ? 'params, ' : ''}query }),`);
  }
  out.push('/** Every website API v2 operation: method and path template. */');
  out.push(`export const OPERATIONS = {\n${table.join('\n')}\n} as const;`, '');
  out.push('export interface Operations {', ...types, '}', '');
  out.push('export type OperationName = keyof Operations;', '');
  out.push(
    '/** A request: path parameters and query; a JSON body and its headers (e.g. `idempotency-key`) for writes. */',
    'export interface CallArgs<K extends OperationName> {',
    "  params?: Operations[K]['params'];",
    "  query?: Operations[K]['query'];",
    "  body?: Operations[K]['body'];",
    "  headers?: Operations[K]['headers'];",
    '}',
    '',
    '/** One method per operation over a generic `call`. */',
    'export function bindOperations(',
    "  call: <K extends OperationName>(op: K, args: CallArgs<K>) => Promise<Operations[K]['response']>,",
    ') {',
    '  return {',
    ...methods,
    '  };',
    '}',
    '',
  );
  return out.join('\n');
}

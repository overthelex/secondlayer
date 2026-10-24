import { types as pgTypes } from 'pg';

/** PostgreSQL OID of the DATE type. */
export const PG_DATE_OID = 1082;

/** The part of `pg.types` this module touches; lets each service pass its own `pg` copy. */
export interface PgTypeRegistry {
  setTypeParser(oid: number, parseFn: (value: string) => any): void;
}

/**
 * Return DATE columns as the plain 'YYYY-MM-DD' string PostgreSQL sent (LEXAI-2105).
 *
 * node-postgres parses DATE into a JS Date at LOCAL midnight. In a Europe/Kyiv container
 * JSON.stringify then writes it in UTC, so 15.12.2017 reaches the client as
 * "2017-12-14T22:00:00.000Z", a day early. A DATE has no time of day, so keep it as text.
 *
 * TIMESTAMP (1114) and TIMESTAMPTZ (1184) are real instants and keep the default Date parser.
 *
 * The parser registry is global per `pg` module copy. The shared package and each service can
 * resolve different copies (Docker copies packages/shared with its own node_modules), so every
 * service also calls this with the `types` it imports itself (see <service>/src/database/database.ts).
 */
export function registerPgTypeParsers(registry: PgTypeRegistry = pgTypes): void {
  registry.setTypeParser(PG_DATE_OID, (value: string) => value);
}

registerPgTypeParsers();

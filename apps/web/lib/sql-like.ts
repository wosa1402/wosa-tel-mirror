import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

const LIKE_ESCAPE_CHAR = "!";

export function escapeLikePattern(value: string): string {
  return value.replaceAll(LIKE_ESCAPE_CHAR, `${LIKE_ESCAPE_CHAR}${LIKE_ESCAPE_CHAR}`).replaceAll("%", "!%").replaceAll("_", "!_");
}

export function ilikeContains(column: SQLWrapper, keyword: string): SQL {
  const escaped = escapeLikePattern(keyword);
  const pattern = `%${escaped}%`;
  return sql`${column} ILIKE ${pattern} ESCAPE '!'`;
}


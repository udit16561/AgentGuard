/** DATABASE_URL uses Prisma-style "file:./dev.db"; better-sqlite3 wants the bare path. */
export function dbPathFromUrl(url: string | undefined): string {
  const value = url ?? 'file:./dev.db';
  return value.startsWith('file:') ? value.slice(5) : value;
}

import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@/generated/mydb";

declare global {
  var __mydbPrisma: PrismaClient | undefined;
}

function buildAdapter(): PrismaMariaDb {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured.");
  const parsed = new URL(url);
  return new PrismaMariaDb({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
    connectionLimit: Number(parsed.searchParams.get("connection_limit")) || 10,
  });
}

const prisma = globalThis.__mydbPrisma ?? new PrismaClient({ adapter: buildAdapter() });
if (process.env.NODE_ENV !== "production") globalThis.__mydbPrisma = prisma;

export default prisma;

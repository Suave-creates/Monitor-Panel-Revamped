import { defineConfig } from "prisma/config";

// The Prisma CLI runs outside Next.js, which is what normally loads `.env`.
try {
  process.loadEnvFile(".env");
} catch {
  // Missing in some environments (e.g. DATABASE_URL supplied directly); ignore.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // `prisma generate` (run during the Docker build, before `.env` exists in
    // that build context — see .dockerignore) only needs a syntactically
    // valid URL, never a reachable one; only `migrate`/`db execute` actually
    // connect, and those are run locally where `.env` is present. The real
    // app never reads this file — src/utils/prisma.ts builds its own
    // connection straight from process.env.DATABASE_URL at runtime.
    url: process.env.DATABASE_URL || "mysql://placeholder:placeholder@localhost:3306/placeholder",
  },
});

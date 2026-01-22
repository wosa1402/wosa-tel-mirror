const path = require("node:path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, ".env"), override: true });

if (!process.env.DATABASE_URL) {
  throw new Error("Missing env DATABASE_URL");
}

/** @type {import("drizzle-kit").Config} */
module.exports = {
  schema: "./src/schema/*.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
};


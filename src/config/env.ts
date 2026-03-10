import { envSchema } from "./schema.js";

export type AppEnv = ReturnType<typeof loadEnv>;

export function loadEnv() {
  return envSchema.parse(process.env);
}

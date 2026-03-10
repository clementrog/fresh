import pino from "pino";

import type { AppEnv } from "../config/env.js";

export function createLogger(env: AppEnv) {
  return pino({
    level: env.LOG_LEVEL,
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : {
            target: "pino-pretty",
            options: {
              colorize: true
            }
          }
  });
}

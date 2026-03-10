import { addDays } from "date-fns";

import type { ConnectorConfig } from "../domain/types.js";

export function computeRawTextExpiry(config: ConnectorConfig, from = new Date()) {
  if (!config.storeRawText) {
    return null;
  }

  return addDays(from, config.retentionDays);
}

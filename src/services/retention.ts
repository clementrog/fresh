import { addDays } from "date-fns";

export function computeRawTextExpiry<T extends { storeRawText: boolean; retentionDays: number }>(config: T, from = new Date()) {
  if (!config.storeRawText) {
    return null;
  }

  return addDays(from, config.retentionDays);
}

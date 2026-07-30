import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const pings = pgTable("pings", {
  id: uuid("id").primaryKey().defaultRandom(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

import { eq } from 'drizzle-orm';
import { pgSchema, text, integer } from 'drizzle-orm/pg-core';
import type { DrizzleCommandDb } from '@server-driven-impact/postgres/drizzle';

export function orderRepository(schemaName: string) {
  const schema = pgSchema(schemaName);
  const orders = schema.table('orders', {
    id: text().primaryKey(),
    tenant_id: text().notNull(),
    customer_id: text(),
    status: text().notNull(),
    priority: integer().notNull(),
    note: text(),
  });
  const items = schema.table('order_items', {
    id: text().primaryKey(),
    tenant_id: text().notNull(),
    order_id: text(),
    amount: integer().notNull(),
  });
  return {
    orders,
    items,
    async move(tx: DrizzleCommandDb, id: string, customer: string) {
      const [order] = await tx.update(orders).set({ customer_id: customer }).where(eq(orders.id, id)).returning();
      return order;
    },
    async total(tx: DrizzleCommandDb, id: string) {
      const rows = await tx
        .select({ amount: items.amount })
        .from(orders)
        .innerJoin(items, eq(orders.id, items.order_id))
        .where(eq(orders.id, id));
      return rows.reduce((sum, row) => sum + row.amount, 0);
    },
  };
}

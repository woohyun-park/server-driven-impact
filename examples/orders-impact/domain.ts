import type { Resources } from '@server-driven-impact/runtime';
import { defineQueries, q, type Input } from '@server-driven-impact/runtime';
export function ordersDomain(schema = 'sdi_orders_example') {
  const resources: Resources = {
    orders: {
      schema,
      table: 'orders',
      idColumn: 'id',
      scopeColumn: 'tenant_id',
      columns: ['id', 'tenant_id', 'customer_id', 'status', 'priority', 'note'],
      cascades: [{ resource: 'items', column: 'order_id' }],
    },
    items: {
      schema,
      table: 'order_items',
      idColumn: 'id',
      scopeColumn: 'tenant_id',
      columns: ['id', 'tenant_id', 'order_id', 'amount'],
    },
  };
  const objectInput = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_INPUT');
    return value as Record<string, unknown>;
  };
  const stringInput = (field: string) => ({
    parse(value: unknown): Input {
      const input = objectInput(value);
      if (typeof input[field] !== 'string') throw new Error(`INVALID_${field.toUpperCase()}`);
      return { [field]: input[field] };
    },
  });
  const emptyInput = {
    parse(value: unknown): Input {
      objectInput(value);
      return {};
    },
  };
  const queries = defineQueries({
    'orders.list': {
      input: stringInput('customer'),
      plan: q.select('orders', {
        columns: ['id', 'customer_id', 'status', 'priority'],
        where: [q.eq('customer_id', q.input('customer'))],
        order: [{ field: 'priority' }, { field: 'id' }],
      }),
    },
    'orders.detail': {
      input: stringInput('id'),
      plan: q.select('orders', {
        where: [q.eq('id', q.input('id'))],
        joins: [
          { as: 'items', resource: 'items', local: 'id', foreign: 'order_id', many: true, order: [{ field: 'id' }] },
        ],
      }),
    },
    'orders.total': {
      input: stringInput('id'),
      plan: q.map(q.select('items', { columns: ['amount'], where: [q.eq('order_id', q.input('id'))] }), rows =>
        (rows as { amount: number }[]).reduce((sum, row) => sum + row.amount, 0),
      ),
    },
    'orders.ready': {
      input: emptyInput,
      plan: q.select('orders', {
        columns: ['id'],
        where: [q.eq('status', q.literal('ready'))],
        order: [{ field: 'priority' }, { field: 'id' }],
      }),
    },
  });
  return { resources, queries };
}

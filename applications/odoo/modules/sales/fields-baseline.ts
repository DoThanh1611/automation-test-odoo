import path from 'node:path';
import type { OdooClient } from '../../client';
import { diffAgainstBaseline as diff, readFieldSnapshot as read, type FieldInfo } from '../../field-baseline';

// Baseline trường của module Sales (dùng cho TC-SO-015). Hàm chung nằm ở applications/odoo/field-baseline.ts.
export const FIELD_MODELS = ['sale.order', 'account.payment'] as const;
export const FIELD_BASELINE_FILE = path.join('baselines', 'odoo-fields.json');

export const readFieldSnapshot = (client: OdooClient) => read(client, FIELD_MODELS);
export const diffAgainstBaseline = (current: Record<string, FieldInfo[]>) => diff(current, FIELD_BASELINE_FILE);

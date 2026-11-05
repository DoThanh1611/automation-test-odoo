import { autotestRef } from './autotest';
import { loadRegistry, recordKey, registerRecord } from './registry';

/**
 * Test Data Factory DÙNG CHUNG (không biết Odoo/MISA): tự sinh dữ liệu test theo test case bằng các "công thức" (Recipe) do từng ứng dụng khai báo.
 * - Mỗi bản ghi tạo ra được ĐĂNG KÝ NGAY vào registry với Environment ID, Run ID, Requirement ID, Test Case ID, chủ sở hữu FRAMEWORK
 *   và quan hệ phụ thuộc (dependsOn), để cleanup biết thứ tự dọn và chủ sở hữu.
 * - Chỉ tạo khi qua cổng ghi (chính sách + giấy phép); không bao giờ dùng/sửa dữ liệu nghiệp vụ có sẵn. Sửa chỉ áp dụng cho bản ghi
 *   do chính lần chạy này tạo (có trong registry với đúng môi trường/lần chạy).
 * - Số bản ghi tối đa mỗi lần chạy theo chính sách (maxRecordsPerRun).
 */
export interface FactoryScope {
  application: string;
  module?: string;
  environment: string;
  runId: string;
  requirementId: string;
  testCaseId: string;
}

export interface Handle {
  /** "model:id". */
  key: string;
  kind: string;
  model: string;
  id: number;
  reference: string;
  dependsOn: string[];
}

export interface RecipeContext<Rpc> {
  rpc: Rpc;
  scope: FactoryScope;
  /** Tham chiếu AUTOTEST chuẩn của bản ghi (khớp quy tắc nhận diện của write guard/cleanup). */
  reference: string;
  /** Chuỗi gắn thẻ đủ bốn ID, để ghi vào trường văn bản tự do của bản ghi. */
  tag: string;
  /** Số thứ tự trong lần tạo (tên duy nhất). */
  seq: number;
}

export interface RecipeResult {
  id: number;
  /** Tham chiếu hiển thị (mặc định ctx.reference). */
  reference?: string;
}

export interface Recipe<Rpc, P = any> {
  kind: string;
  model: string;
  /** Tạo bản ghi. Mọi lỗi ở bước này nghĩa là chưa có gì được tạo. */
  create(ctx: RecipeContext<Rpc>, params: P, deps: Record<string, Handle>): Promise<RecipeResult>;
  /** Bước tiếp theo SAU khi bản ghi đã được đăng ký (ví dụ xác nhận SO). Lỗi ở đây không làm mất dấu bản ghi đã tạo. */
  finalize?(ctx: RecipeContext<Rpc>, rec: Handle, params: P, deps: Record<string, Handle>): Promise<void>;
  /** Bản ghi con do hệ thống tự sinh khi tạo/hoàn tất bản ghi này (ví dụ phiếu giao của SO). Được đăng ký vào registry, phụ thuộc bản ghi này. */
  children?(ctx: RecipeContext<Rpc>, rec: Handle, params: P): Promise<(RecipeResult & { model: string })[]>;
  /** Sửa bản ghi do framework tạo. */
  update?(ctx: RecipeContext<Rpc>, rec: Handle, vals: Record<string, unknown>): Promise<void>;
}

export interface PlanNode {
  kind: string;
  params?: unknown;
  /** Khoá các node khác trong kế hoạch mà node này phụ thuộc (tạo trước). */
  requires?: string[];
}
export type DataPlan = Record<string, PlanNode>;

export interface FactoryOptions<Rpc> {
  rpc: Rpc;
  recipes: Recipe<Rpc>[];
  scope: FactoryScope;
  /** Lý do KHÔNG được ghi (cổng ghi: chính sách + giấy phép). Rỗng = được ghi. */
  writeProblems: () => string[];
  maxRecordsPerRun: number;
  /** Công thức động cho kind chưa có công thức khai báo sẵn (adapter tự sinh từ lược đồ model). undefined = không có. */
  resolveRecipe?: (kind: string) => Recipe<Rpc> | undefined;
}

export class FactoryError extends Error {}

export class DataFactory<Rpc> {
  readonly created: Handle[] = [];
  private seq = 0;

  constructor(private o: FactoryOptions<Rpc>) {}

  private recipe(kind: string): Recipe<Rpc> {
    const r = this.o.recipes.find((x) => x.kind === kind) ?? this.o.resolveRecipe?.(kind);
    if (!r) throw new FactoryError(`Chưa có công thức tạo dữ liệu "${kind}" (có: ${this.o.recipes.map((x) => x.kind).join(', ')})`);
    return r;
  }

  private gate() {
    const problems = this.o.writeProblems();
    if (problems.length) throw new FactoryError(`Từ chối tạo/sửa dữ liệu: ${problems.join('; ')}`);
  }

  /** Số bản ghi framework đã tạo trong lần chạy này (kể cả do tiến trình/worker khác) theo registry của môi trường. */
  private existingInRun(): number {
    return loadRegistry().filter((r) => r.runId === this.o.scope.runId && r.owner === 'FRAMEWORK' && r.environment === this.o.scope.environment).length;
  }

  private ctx(seq: number): RecipeContext<Rpc> {
    const s = this.o.scope;
    return { rpc: this.o.rpc, scope: s, seq, reference: autotestRef(s.runId, s.testCaseId), tag: `QA env=${s.environment} run=${s.runId} req=${s.requirementId} tc=${s.testCaseId}` };
  }

  async create(kind: string, params: unknown = {}, deps: Record<string, Handle> = {}): Promise<Handle> {
    this.gate();
    const recipe = this.recipe(kind);
    if (this.existingInRun() >= this.o.maxRecordsPerRun) {
      throw new FactoryError(`Đã đạt giới hạn ${this.o.maxRecordsPerRun} bản ghi test của lần chạy ${this.o.scope.runId} (chính sách maxRecordsPerRun)`);
    }
    for (const [name, d] of Object.entries(deps)) {
      if (!this.owned(d)) throw new FactoryError(`Phụ thuộc "${name}" (${d.key}) không phải dữ liệu do lần chạy này tạo`);
    }
    const ctx = this.ctx(++this.seq);
    const res = await recipe.create(ctx, params, deps);
    const s = this.o.scope;
    const handle: Handle = { key: `${recipe.model}:${res.id}`, kind, model: recipe.model, id: res.id, reference: res.reference ?? ctx.reference, dependsOn: Object.values(deps).map((d) => d.key) };
    // Đăng ký NGAY (trước mọi bước tiếp theo) để dù bước sau lỗi, dữ liệu vẫn nằm trong registry và được cleanup.
    registerRecord({
      testCaseId: s.testCaseId, application: s.application, module: s.module, model: recipe.model, recordId: res.id, reference: handle.reference,
      runId: s.runId, environment: s.environment, requirementId: s.requirementId, dependsOn: handle.dependsOn, parent: handle.dependsOn[0], owner: 'FRAMEWORK', origin: 'AUTOMATION',
    });
    this.created.push(handle);
    if (recipe.finalize) await recipe.finalize(ctx, handle, params, deps);
    if (recipe.children) {
      // Bản ghi con do hệ thống tự sinh (ví dụ phiếu giao khi xác nhận SO) cũng là dữ liệu test: đăng ký để cleanup không bỏ sót.
      for (const c of await recipe.children(ctx, handle, params)) {
        registerRecord({
          testCaseId: s.testCaseId, application: s.application, module: s.module, model: c.model, recordId: c.id, reference: c.reference ?? ctx.reference,
          runId: s.runId, environment: s.environment, requirementId: s.requirementId, dependsOn: [handle.key], parent: handle.key, owner: 'FRAMEWORK', origin: 'AUTOMATION',
        });
      }
    }
    return handle;
  }

  /** Bản ghi do chính lần chạy này (môi trường này) tạo: có trong registry với owner FRAMEWORK. */
  owned(h: Handle): boolean {
    const s = this.o.scope;
    const reg = loadRegistry().find((r) => recordKey(r) === `${s.application}|${h.model}|${h.id}`);
    return Boolean(reg && reg.origin === 'AUTOMATION' && reg.owner === 'FRAMEWORK' && reg.runId === s.runId && reg.environment === s.environment);
  }

  async update(h: Handle, vals: Record<string, unknown>): Promise<void> {
    this.gate();
    if (!this.owned(h)) throw new FactoryError(`Từ chối sửa ${h.key}: không phải dữ liệu framework của lần chạy ${this.o.scope.runId} trên môi trường ${this.o.scope.environment}`);
    const recipe = this.recipe(h.kind);
    if (!recipe.update) throw new FactoryError(`Công thức "${h.kind}" không hỗ trợ sửa`);
    await recipe.update(this.ctx(++this.seq), h, vals);
  }

  /** Thực hiện kế hoạch theo thứ tự phụ thuộc (tạo cái được yêu cầu trước). Chu trình hoặc phụ thuộc không tồn tại => lỗi, chưa tạo gì. */
  async build(plan: DataPlan): Promise<Record<string, Handle>> {
    const order = planOrder(plan);
    const out: Record<string, Handle> = {};
    for (const key of order) {
      const node = plan[key];
      const deps = Object.fromEntries((node.requires ?? []).map((r) => [r, out[r]]));
      out[key] = await this.create(node.kind, node.params ?? {}, deps);
    }
    return out;
  }
}

/** Thứ tự tạo (phụ thuộc trước). Ném FactoryError nếu node yêu cầu node không tồn tại hoặc có chu trình. Thuần hàm. */
export function planOrder(plan: DataPlan): string[] {
  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (k: string, path: string[]) => {
    if (state.get(k) === 'done') return;
    if (state.get(k) === 'visiting') throw new FactoryError(`Kế hoạch dữ liệu có chu trình: ${[...path, k].join(' → ')}`);
    state.set(k, 'visiting');
    for (const r of plan[k].requires ?? []) {
      if (!plan[r]) throw new FactoryError(`Node "${k}" yêu cầu "${r}" nhưng kế hoạch không có node đó`);
      visit(r, [...path, k]);
    }
    state.set(k, 'done');
    order.push(k);
  };
  for (const k of Object.keys(plan)) visit(k, []);
  return order;
}

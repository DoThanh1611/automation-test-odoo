import fs from 'node:fs';
import path from 'node:path';
import { getRunId } from '../config/run';
import { activeEnvKey, registryPathFor } from '../environment/paths';
import { loadTestCases } from '../testcases/loader';

/**
 * Test Data Registry: sổ cái các bản ghi do automation tạo ra, dùng chung cho mọi ứng dụng/module
 * (không biết gì về Sales Order). Lưu dạng JSON Lines, chỉ GHI THÊM (append-only): mỗi dòng là một sự kiện,
 * trạng thái hiện tại được suy ra bằng cách gộp các sự kiện theo khoá bản ghi.
 */
/**
 * PENDING: chờ cleanup. RETAINED: giữ lại có chủ đích (test FAIL, tới retainUntil). CLEANED: đã dọn.
 * CLEANUP_BLOCKED: cleanup không làm được (kèm lý do trong note), cần người xử lý; KHÔNG đổi kết quả kiểm thử.
 * PLANNED/SKIPPED/FAILED: trạng thái cũ (giữ để đọc dữ liệu trước đây).
 */
export type CleanupStatus = 'PENDING' | 'PLANNED' | 'CLEANED' | 'SKIPPED' | 'FAILED' | 'RETAINED' | 'CLEANUP_BLOCKED';

/** AUTOMATION: đăng ký lúc tạo (đáng tin). BACKFILL: nhận diện sau theo tiền tố tham chiếu (cần xác minh). */
export type Origin = 'AUTOMATION' | 'BACKFILL';

export interface TestDataRecord {
  runId: string;
  testCaseId: string;
  application: string;
  /** Module sở hữu bản ghi (ví dụ sales, purchase). Bản ghi cũ (trước khi có trường này) không có giá trị. */
  module?: string;
  model: string;
  recordId: number;
  reference: string;
  createdAt: string;
  cleanupStatus: CleanupStatus;
  origin: Origin;
  /** Bản ghi cha (ví dụ phiếu thu thuộc SO nào), dạng "model:id". */
  parent?: string;
  note?: string;
  /** Môi trường (ví dụ STAGING_A) nơi bản ghi được tạo. Mỗi môi trường một sổ riêng; trường này để đối chiếu chéo. */
  environment?: string;
  requirementId?: string;
  /** Các bản ghi mà bản ghi này PHỤ THUỘC (phải tồn tại trước), dạng "model:id". Cleanup dọn bản ghi phụ thuộc trước. */
  dependsOn?: string[];
  /** Chủ sở hữu: FRAMEWORK = do Test Data Factory/automation tạo. Cleanup tự động chỉ động vào FRAMEWORK. */
  owner?: 'FRAMEWORK';
  /** ISO: tới thời điểm này dữ liệu (của test FAIL) được giữ để điều tra. */
  retainUntil?: string;
  /** Thời điểm cleanup xong. */
  cleanedAt?: string;
}

type Event =
  | ({ event: 'created' } & TestDataRecord)
  | { event: 'status'; key: string; cleanupStatus: CleanupStatus; at: string; note?: string; retainUntil?: string };

/** Mỗi môi trường một sổ riêng (testdata/registry/<ENV>.jsonl): ID bản ghi trùng giữa các môi trường không thể lẫn nhau. */
export const registryFile = () => registryPathFor();
export const recordKey = (r: Pick<TestDataRecord, 'application' | 'model' | 'recordId'>) =>
  `${r.application}|${r.model}|${r.recordId}`;

function append(ev: Event) {
  const file = registryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(ev) + '\n');
}

/** Gộp các sự kiện thành trạng thái hiện tại của từng bản ghi. */
export function loadRegistry(): TestDataRecord[] {
  const file = registryFile();
  if (!fs.existsSync(file)) return [];
  const map = new Map<string, TestDataRecord>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line) as Event;
    if (ev.event === 'created') {
      const { event: _e, ...rec } = ev;
      if (!map.has(recordKey(rec))) map.set(recordKey(rec), rec); // đăng ký lặp: giữ bản đầu tiên
    } else {
      const cur = map.get(ev.key);
      if (cur) {
        map.set(ev.key, {
          ...cur, cleanupStatus: ev.cleanupStatus, note: ev.note ?? cur.note,
          retainUntil: ev.cleanupStatus === 'RETAINED' ? ev.retainUntil ?? cur.retainUntil : cur.retainUntil,
          cleanedAt: ev.cleanupStatus === 'CLEANED' ? ev.at : cur.cleanedAt,
        });
      }
    }
  }
  return [...map.values()];
}

export interface NewRecord {
  testCaseId: string;
  application: string;
  module?: string;
  model: string;
  recordId: number;
  reference: string;
  parent?: string;
  runId?: string;
  origin?: Origin;
  createdAt?: string;
  note?: string;
  environment?: string;
  requirementId?: string;
  dependsOn?: string[];
  owner?: 'FRAMEWORK';
}

/** Requirement của một test case (để gắn Requirement ID cho dữ liệu test). undefined nếu không tra được. */
function requirementOf(testCaseId: string): string | undefined {
  try {
    return loadTestCases().find((d) => d.id === testCaseId)?.requirementId;
  } catch {
    return undefined;
  }
}

/** Đăng ký 1 bản ghi do automation tạo. Gọi NGAY sau khi tạo; bỏ qua nếu đã đăng ký. */
export function registerRecord(r: NewRecord): TestDataRecord {
  const rec: TestDataRecord = {
    runId: r.runId ?? getRunId(),
    testCaseId: r.testCaseId,
    application: r.application,
    module: r.module,
    model: r.model,
    recordId: r.recordId,
    reference: r.reference,
    createdAt: r.createdAt ?? new Date().toISOString(),
    cleanupStatus: 'PENDING',
    origin: r.origin ?? 'AUTOMATION',
    parent: r.parent,
    note: r.note,
    environment: r.environment ?? activeEnvKey(),
    requirementId: r.requirementId ?? requirementOf(r.testCaseId),
    dependsOn: r.dependsOn,
    owner: r.owner,
  };
  if (loadRegistry().some((x) => recordKey(x) === recordKey(rec))) return rec;
  append({ event: 'created', ...rec });
  return rec;
}

export function setCleanupStatus(rec: Pick<TestDataRecord, 'application' | 'model' | 'recordId'>, status: CleanupStatus, note?: string, retainUntil?: string) {
  append({ event: 'status', key: recordKey(rec), cleanupStatus: status, at: new Date().toISOString(), note, retainUntil });
}

export const recordsOfRun = (runId: string) => loadRegistry().filter((r) => r.runId === runId);

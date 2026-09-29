import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  Checkpoint,
  CheckpointPart,
  CheckpointPartState,
  CheckpointSnapshot,
  RestorePartResult,
  RestoreResult
} from '@/types/checkpoint'
import { CHECKPOINT_ID, CHECKPOINT_PARTS } from '@/types/checkpoint'
import { db } from '@/utils/db'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'
import { useSessionStore } from '@/stores/sessionStore'

/** 初始的四块恢复状态 */
function initialPartStates(now: number): Record<CheckpointPart, CheckpointPartState> {
  return {
    sessions: { status: 'pending', error: null, attempts: 0, updatedAt: now },
    fixtures: { status: 'pending', error: null, attempts: 0, updatedAt: now },
    cues: { status: 'pending', error: null, attempts: 0, updatedAt: now },
    levels: { status: 'pending', error: null, attempts: 0, updatedAt: now }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return '写入本地数据库失败'
}

/**
 * 深拷贝一批可能被 Vue 包成响应式 Proxy 的纯数据对象。
 * structuredClone 无法克隆响应式 Proxy（含嵌套代理），这些模型均为可 JSON 序列化的纯数据，
 * 直接走 JSON 通道得到与响应式系统脱钩的纯对象。
 */
function cloneRecords<T>(records: readonly T[]): T[] {
  return JSON.parse(JSON.stringify(records)) as T[]
}

/**
 * 联排检查点仓库：为整场保留一个快照检查点，并按「场次 / 通道配接 / Cue / 电平」
 * 四块分别落库恢复，任一块失败都保留待处理记录，重开页面后可继续或放弃。
 * 排演表不属于快照，恢复时不动，始终保留。
 */
export const useCheckpointStore = defineStore('checkpoint', () => {
  const checkpoint = ref<Checkpoint | null>(null)
  const hydrated = ref(false)
  /** 是否有恢复流程正在执行（防并发） */
  const restoring = ref(false)

  const hasCheckpoint = computed(() => checkpoint.value !== null)
  const isRestoring = computed(() => checkpoint.value?.status === 'restoring')
  /** 当前未成功的数据块（中断恢复或失败重试时需要处理） */
  const failedParts = computed<CheckpointPart[]>(() =>
    checkpoint.value ? CHECKPOINT_PARTS.filter((part) => checkpoint.value?.parts[part].status !== 'success') : []
  )

  /** 快照中各块的条目数量，用于界面概览 */
  const snapshotCounts = computed(() => {
    const snapshot = checkpoint.value?.snapshot
    if (!snapshot) return { sessions: 0, fixtures: 0, cues: 0, levels: 0 }
    return {
      sessions: snapshot.sessions.length,
      fixtures: snapshot.fixtures.length,
      cues: snapshot.cues.length,
      levels: snapshot.levels.length
    }
  })

  async function hydrate(): Promise<void> {
    checkpoint.value = (await db.checkpoints.get(CHECKPOINT_ID)) ?? null
    hydrated.value = true
  }

  async function persist(next: Checkpoint): Promise<void> {
    // 快照可能仍引用响应式对象，IndexedDB 的结构化克隆无法克隆 Proxy，统一走 JSON 通道序列化
    await db.checkpoints.put(JSON.parse(JSON.stringify(next)) as Checkpoint)
    checkpoint.value = next
  }

  /**
   * 覆盖式恢复某一个数据块：清空该表现有数据，再写回检查点快照。
   * 每块独立事务，失败只影响自身，不波及其他块。
   */
  async function restorePart(part: CheckpointPart, snapshot: CheckpointSnapshot): Promise<void> {
    switch (part) {
      case 'sessions':
        await db.transaction('rw', db.sessions, async () => {
          await db.sessions.clear()
          if (snapshot.sessions.length > 0) await db.sessions.bulkPut(cloneRecords(snapshot.sessions))
        })
        return
      case 'fixtures':
        await db.transaction('rw', db.fixtures, async () => {
          await db.fixtures.clear()
          if (snapshot.fixtures.length > 0) await db.fixtures.bulkPut(cloneRecords(snapshot.fixtures))
        })
        return
      case 'cues':
        await db.transaction('rw', db.cues, async () => {
          await db.cues.clear()
          if (snapshot.cues.length > 0) await db.cues.bulkPut(cloneRecords(snapshot.cues))
        })
        return
      case 'levels':
        await db.transaction('rw', db.levels, async () => {
          await db.levels.clear()
          if (snapshot.levels.length > 0) await db.levels.bulkPut(cloneRecords(snapshot.levels))
        })
        return
    }
  }

  /**
   * 执行恢复：按顺序逐块落库，已成功的块在继续恢复时跳过。
   * 每块开始前、结束后都立即落盘检查点状态，保证中途关闭页面时进度不丢。
   */
  async function executeRestore(current: Checkpoint): Promise<RestoreResult> {
    restoring.value = true
    const results: RestorePartResult[] = []
    try {
      for (const part of CHECKPOINT_PARTS) {
        const partState = current.parts[part]
        // 全部成功后再次进入（一般不会发生）或继续恢复时，已成功的块保持成果、直接跳过
        if (partState.status === 'success') {
          results.push({ part, ok: true, error: null })
          continue
        }

        current = {
          ...current,
          parts: {
            ...current.parts,
            [part]: { ...partState, attempts: partState.attempts + 1, updatedAt: Date.now() }
          }
        }
        await persist(current)

        try {
          await restorePart(part, current.snapshot)
          current = {
            ...current,
            parts: {
              ...current.parts,
              [part]: { status: 'success', error: null, attempts: current.parts[part].attempts, updatedAt: Date.now() }
            }
          }
          results.push({ part, ok: true, error: null })
        } catch (error) {
          const message = errorMessage(error)
          current = {
            ...current,
            parts: {
              ...current.parts,
              [part]: {
                status: 'failed',
                error: message,
                attempts: current.parts[part].attempts,
                updatedAt: Date.now()
              }
            }
          }
          results.push({ part, ok: false, error: message })
        }
        await persist(current)
      }

      const failed = results.filter((result) => !result.ok).map((result) => result.part)
      const now = Date.now()
      if (failed.length === 0) {
        await persist({
          ...current,
          status: 'available',
          restoreStartedAt: null,
          lastRestoredAt: now
        })
      }
      // 有失败块时保持 status='restoring'，保留待处理记录（已成功块的成果也保留）

      await refreshStores()

      return { completed: failed.length === 0, parts: results, failedParts: failed }
    } finally {
      restoring.value = false
    }
  }

  /** 恢复落库后把四个业务仓库重新载入内存，并作废派生缓存 */
  async function refreshStores(): Promise<void> {
    const sessionStore = useSessionStore()
    const fixtureStore = useFixtureStore()
    const cueStore = useCueStore()
    const levelStore = useLevelStore()
    // 先载入场次，再载入依赖它的其余三表
    await sessionStore.hydrate()
    await Promise.all([fixtureStore.hydrate(), cueStore.hydrate(), levelStore.hydrate()])
    fixtureStore.invalidatePatchChecks()
    sessionStore.ensureCurrentSession()
    const validCueIds = new Set(cueStore.cues.map((cue) => cue.id))
    cueStore.setSelection(cueStore.selectedCueIds.filter((id) => validCueIds.has(id)))
  }

  /** 创建（覆盖）联排前检查点：快照当前的场次 / 通道 / Cue / 电平 */
  async function createCheckpoint(label?: string): Promise<Checkpoint | null> {
    const sessionStore = useSessionStore()
    const fixtureStore = useFixtureStore()
    const cueStore = useCueStore()
    const levelStore = useLevelStore()
    const now = Date.now()

    const created: Checkpoint = {
      id: CHECKPOINT_ID,
      label: label?.trim() || `联排前检查点 · ${formatStamp(now)}`,
      createdAt: now,
      lastRestoredAt: null,
      lastRestoreStartedAt: null,
      status: 'available',
      restoreStartedAt: null,
      parts: initialPartStates(now),
      snapshot: {
        sessions: cloneRecords(sessionStore.sessions),
        fixtures: cloneRecords(fixtureStore.fixtures),
        cues: cloneRecords(cueStore.cues),
        levels: cloneRecords(levelStore.levels)
      }
    }
    await persist(created)
    return created
  }

  /** 开始恢复检查点：四块重置为待处理并进入 restoring */
  async function startRestore(): Promise<RestoreResult | null> {
    const current = checkpoint.value
    if (!current || restoring.value) return null
    const now = Date.now()
    const pending = initialPartStates(now)
    const started: Checkpoint = {
      ...current,
      status: 'restoring',
      restoreStartedAt: now,
      lastRestoreStartedAt: now,
      parts: pending
    }
    await persist(started)
    return executeRestore(started)
  }

  /** 继续上次未完成的恢复：只重试未成功的块 */
  async function continueRestore(): Promise<RestoreResult | null> {
    const current = checkpoint.value
    if (!current || current.status !== 'restoring' || restoring.value) return null
    return executeRestore(current)
  }

  /** 放弃待处理记录：检查点回到可恢复状态、分块状态重置；已换回的成果保留 */
  async function discardPendingRestore(): Promise<Checkpoint | null> {
    const current = checkpoint.value
    if (!current) return null
    const next: Checkpoint = {
      ...current,
      status: 'available',
      restoreStartedAt: null,
      parts: initialPartStates(Date.now())
    }
    await persist(next)
    await refreshStores()
    return next
  }

  /** 删除检查点（不影响当前业务数据与排演表） */
  async function removeCheckpoint(): Promise<void> {
    await db.checkpoints.delete(CHECKPOINT_ID)
    checkpoint.value = null
  }

  /**
   * 判断某张排演表是否为「检查点之后、最近一次恢复开始之前」生成——
   * 这些表保留不删，但要在列表里注明它来自恢复前。
   * 用恢复开始时间界定（恢复一开始就可标注，不必等到全部成功）；
   * 旧检查点记录没有该字段时回退用恢复完成时间。
   */
  function isSheetFromBeforeRestore(sheetGeneratedAt: string): boolean {
    const current = checkpoint.value
    if (!current) return false
    const restoreAt = current.lastRestoreStartedAt ?? current.lastRestoredAt
    if (restoreAt === null) return false
    const generated = new Date(sheetGeneratedAt).getTime()
    if (!Number.isFinite(generated)) return false
    return generated > current.createdAt && generated < restoreAt
  }

  return {
    checkpoint,
    hydrated,
    restoring,
    hasCheckpoint,
    isRestoring,
    failedParts,
    snapshotCounts,
    hydrate,
    createCheckpoint,
    startRestore,
    continueRestore,
    discardPendingRestore,
    removeCheckpoint,
    isSheetFromBeforeRestore
  }
})

/** 时间戳 → `YYYY-MM-DD HH:mm`，用于默认检查点说明 */
function formatStamp(value: number): string {
  const date = new Date(value)
  const pad = (input: number): string => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`
}

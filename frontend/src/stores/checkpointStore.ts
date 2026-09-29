import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  RESTORE_PARTS,
  RESTORE_PART_LABELS,
  SHEET_MARK_PART,
  type Checkpoint,
  type CheckpointSnapshot,
  type RestorePart,
  type RestoreStep
} from '@/types/checkpoint'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import { deepToPlain } from '@/utils/clone'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSheetStore } from '@/stores/sheetStore'

/** 检查点建立后返回的摘要 */
export interface CheckpointSummary {
  checkpoint: Checkpoint
}

/** 一次（可能跨页面重开的）恢复执行结果 */
export interface RestoreOutcome {
  /** 全部数据块与排演表标注均成功 */
  finished: boolean
  /** 本次执行前 / 后各数据块的完成情况 */
  doneParts: RestorePart[]
  /** 没成功的那一块（数据块或排演表标注）；全部成功时为 null */
  failedPart: RestoreStep | null
  /** 给舞台监督看的结论说明 */
  message: string
  /** 补标为「来自恢复前」的排演表数量 */
  markedSheetCount: number
}

function freshParts(): Record<RestorePart, 'pending'> {
  return { sessions: 'pending', fixtures: 'pending', cues: 'pending', levels: 'pending' }
}

/** 深拷贝快照，避免 store / 页面里的对象变更反向污染已落库的检查点 */
function cloneSnapshot(snapshot: CheckpointSnapshot): CheckpointSnapshot {
  return {
    sessions: deepToPlain(snapshot.sessions),
    fixtures: deepToPlain(snapshot.fixtures),
    cues: deepToPlain(snapshot.cues),
    levels: deepToPlain(snapshot.levels)
  }
}

/**
 * 联排检查点仓库：
 * - 建立：把场次 / 灯位通道 / Cue / 通道电平整体快照存档（排演表不纳入快照，始终保留）；
 * - 恢复：四个数据块各自独立事务、逐块落库并记录状态，任一块失败都不会被标记为完成，
 *   进度随检查点持久化，重开页面后可继续或放弃；
 * - 收尾：全部数据块换回后，把检查点之后生成的排演表补标「来自恢复前」。
 */
export const useCheckpointStore = defineStore('checkpoint', () => {
  const checkpoints = ref<Checkpoint[]>([])
  const hydrated = ref(false)
  /** 恢复执行锁，避免重复触发 */
  const restoring = ref(false)

  /** 全场只保留一个检查点，按建立时间倒序 */
  const sortedCheckpoints = computed(() =>
    [...checkpoints.value].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  )

  const currentCheckpoint = computed<Checkpoint | null>(() => sortedCheckpoints.value[0] ?? null)

  /** 上次恢复没完成（含数据块失败或排演表标注失败）的检查点 */
  const pendingRestoreCheckpoint = computed(
    () => checkpoints.value.find((checkpoint) => checkpoint.restore !== null && checkpoint.restore.finishedAt === null) ?? null
  )

  function checkpointById(id: string): Checkpoint | null {
    return checkpoints.value.find((checkpoint) => checkpoint.id === id) ?? null
  }

  async function hydrate(): Promise<void> {
    checkpoints.value = await db.checkpoints.toArray()
    hydrated.value = true
  }

  function persistLocal(next: Checkpoint): void {
    checkpoints.value = checkpoints.value.map((item) => (item.id === next.id ? next : item))
  }

  /** 把恢复进度写回 IndexedDB，保证页面重开后仍能看到待处理记录 */
  async function persistRestoreState(checkpoint: Checkpoint): Promise<void> {
    if (!checkpoint.restore) return
    // checkpoint 来自响应式数组（Proxy），写入 IndexedDB 前先转成纯数据
    await db.checkpoints.put(deepToPlain(checkpoint))
    persistLocal({ ...checkpoint })
  }

  /**
   * 建立联排检查点（整场只保留一个）。存在未完成恢复时不允许建立；
   * 已有检查点时直接由新检查点取代（旧检查点没有待处理恢复，可安全移除）。
   */
  async function createCheckpoint(label: string, note: string): Promise<Checkpoint> {
    if (pendingRestoreCheckpoint.value) {
      throw new Error('上次恢复尚未完成，请先继续完成或放弃后再建立新检查点')
    }
    const [sessions, fixtures, cues, levels] = await Promise.all([
      db.sessions.toArray(),
      db.fixtures.toArray(),
      db.cues.toArray(),
      db.levels.toArray()
    ])

    const checkpoint: Checkpoint = {
      id: createId('cp'),
      label: label.trim() || '联排前检查点',
      note: note.trim(),
      createdAt: new Date().toISOString(),
      snapshot: {
        sessions: deepToPlain(sessions),
        fixtures: deepToPlain(fixtures),
        cues: deepToPlain(cues),
        levels: deepToPlain(levels)
      },
      counts: { sessions: sessions.length, fixtures: fixtures.length, cues: cues.length, levels: levels.length },
      restore: null
    }
    await db.transaction('rw', db.checkpoints, async () => {
      await db.checkpoints.clear()
      await db.checkpoints.put(checkpoint)
    })
    checkpoints.value = [checkpoint]
    return checkpoint
  }

  async function removeCheckpoint(id: string): Promise<void> {
    const target = checkpointById(id)
    if (!target) return
    if (target.restore && target.restore.finishedAt === null) {
      throw new Error('该检查点的恢复尚未完成，请先继续或放弃')
    }
    await db.checkpoints.delete(id)
    checkpoints.value = checkpoints.value.filter((item) => item.id !== id)
  }

  /** 建立恢复进度记录（全部块 pending），不立即执行 */
  async function startRestore(id: string): Promise<Checkpoint> {
    const target = checkpointById(id)
    if (!target) throw new Error('检查点不存在或已删除')
    if (pendingRestoreCheckpoint.value && pendingRestoreCheckpoint.value.id !== id) {
      throw new Error('已有另一场恢复尚未完成')
    }
    if (restoring.value) throw new Error('恢复正在执行中')

    if (target.restore === null || target.restore.finishedAt !== null) {
      target.restore = {
        startedAt: new Date().toISOString(),
        finishedAt: null,
        parts: freshParts(),
        sheetMark: { status: 'pending', error: null },
        lastError: null
      }
      await persistRestoreState(target)
    }
    return target
  }

  /** 单块整表换回：清空后整批写入，并在同一事务内核对条数，确保没写全也算失败 */
  async function replacePart(part: RestorePart, snapshot: CheckpointSnapshot): Promise<void> {
    if (part === 'sessions') {
      const rows = snapshot.sessions
      await db.transaction('rw', db.sessions, async () => {
        await db.sessions.clear()
        if (rows.length > 0) await db.sessions.bulkPut(deepToPlain(rows))
        const count = await db.sessions.count()
        if (count !== rows.length) throw new Error(`写入后条数不符（期望 ${rows.length}，实际 ${count}）`)
      })
      return
    }
    if (part === 'fixtures') {
      const rows = snapshot.fixtures
      await db.transaction('rw', db.fixtures, async () => {
        await db.fixtures.clear()
        if (rows.length > 0) await db.fixtures.bulkPut(deepToPlain(rows))
        const count = await db.fixtures.count()
        if (count !== rows.length) throw new Error(`写入后条数不符（期望 ${rows.length}，实际 ${count}）`)
      })
      return
    }
    if (part === 'cues') {
      const rows = snapshot.cues
      await db.transaction('rw', db.cues, async () => {
        await db.cues.clear()
        if (rows.length > 0) await db.cues.bulkPut(deepToPlain(rows))
        const count = await db.cues.count()
        if (count !== rows.length) throw new Error(`写入后条数不符（期望 ${rows.length}，实际 ${count}）`)
      })
      return
    }
    const rows = snapshot.levels
    await db.transaction('rw', db.levels, async () => {
      await db.levels.clear()
      if (rows.length > 0) await db.levels.bulkPut(deepToPlain(rows))
      const count = await db.levels.count()
      if (count !== rows.length) throw new Error(`写入后条数不符（期望 ${rows.length}，实际 ${count}）`)
    })
  }

  /** 某块换回成功后，把对应 store 的内存状态同步成数据库现状 */
  async function syncStoreAfterPart(part: RestorePart): Promise<void> {
    const sessionStore = useSessionStore()
    const fixtureStore = useFixtureStore()
    const cueStore = useCueStore()
    const levelStore = useLevelStore()
    switch (part) {
      case 'sessions':
        await sessionStore.hydrate()
        sessionStore.ensureCurrentSession()
        return
      case 'fixtures':
        await fixtureStore.hydrate()
        fixtureStore.patchChecks = {}
        return
      case 'cues':
        await cueStore.hydrate()
        cueStore.clearSelection()
        return
      case 'levels':
        await levelStore.hydrate()
        return
    }
  }

  /**
   * 继续执行恢复：跳过已完成的块，按顺序处理 pending 块，遇到失败立即停下并记录。
   * 全部数据块成功后再补标排演表；任一步失败 finished=false，页面不得显示恢复完成。
   */
  async function runPendingRestore(id: string): Promise<RestoreOutcome> {
    const target = checkpointById(id)
    if (!target || !target.restore) {
      return {
        finished: false,
        doneParts: [],
        failedPart: null,
        message: '检查点不存在或没有待继续的恢复记录',
        markedSheetCount: 0
      }
    }
    if (target.restore.finishedAt !== null) {
      return {
        finished: true,
        doneParts: [...RESTORE_PARTS],
        failedPart: null,
        message: '该检查点的恢复已完成。',
        markedSheetCount: 0
      }
    }
    if (restoring.value) {
      return {
        finished: false,
        doneParts: RESTORE_PARTS.filter((part) => target.restore?.parts[part] === 'done'),
        failedPart: null,
        message: '恢复正在执行中，请勿重复操作',
        markedSheetCount: 0
      }
    }

    restoring.value = true
    let failedPart: RestoreStep | null = null
    try {
      const snapshot = cloneSnapshot(target.snapshot)

      for (const part of RESTORE_PARTS) {
        if (target.restore.parts[part] === 'done') continue
        try {
          await replacePart(part, snapshot)
          await syncStoreAfterPart(part)
        } catch (error) {
          failedPart = part
          target.restore.parts[part] = 'failed'
          target.restore.lastError = { part, message: error instanceof Error ? error.message : String(error) }
          await persistRestoreState(target)
          break
        }
        target.restore.parts[part] = 'done'
        target.restore.lastError = null
        await persistRestoreState(target)
      }

      // 四个数据块全部换回后，才处理检查点之后生成的排演表
      if (!failedPart) {
        if (target.restore.sheetMark.status !== 'done') {
          try {
            const sheetStore = useSheetStore()
            const markedCount = await sheetStore.markPreRestoreSheets(target.id, target.createdAt)
            target.restore.sheetMark = { status: 'done', error: null }
            target.restore.lastError = null
            target.restore.finishedAt = new Date().toISOString()
            await persistRestoreState(target)
            return {
              finished: true,
              doneParts: [...RESTORE_PARTS],
              failedPart: null,
              message:
                markedCount > 0
                  ? `恢复完成：场次、Cue、通道配接与电平已全部换回；检查点之后生成的 ${markedCount} 张排演表已保留并注明「来自恢复前」。`
                  : '恢复完成：场次、Cue、通道配接与电平已全部换回。',
              markedSheetCount: markedCount
            }
          } catch (error) {
            failedPart = SHEET_MARK_PART
            target.restore.sheetMark = {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error)
            }
            target.restore.lastError = {
              part: SHEET_MARK_PART,
              message: error instanceof Error ? error.message : String(error)
            }
            await persistRestoreState(target)
          }
        } else if (target.restore.finishedAt === null) {
          target.restore.finishedAt = new Date().toISOString()
          await persistRestoreState(target)
          return {
            finished: true,
            doneParts: [...RESTORE_PARTS],
            failedPart: null,
            message: '恢复完成：场次、Cue、通道配接与电平已全部换回。',
            markedSheetCount: 0
          }
        }
      }
    } finally {
      restoring.value = false
    }

    const doneParts = RESTORE_PARTS.filter((part) => target.restore?.parts[part] === 'done')
    const failedLabel = failedPart ? RESTORE_PART_LABELS[failedPart] : ''
    const reason = target.restore.lastError?.message ?? '未知错误'
    return {
      finished: false,
      doneParts,
      failedPart,
      message: failedPart
        ? `恢复未完成：「${failedLabel}」没有换回成功（${reason}）。其余成功的块已生效，可处理后继续恢复；在此之前系统不会标记为恢复完成。`
        : '恢复未完成，请稍后继续。',
      markedSheetCount: 0
    }
  }

  /** 放弃恢复：仅清除待处理记录，已换回的数据块保持现状，检查点仍保留可再次恢复 */
  async function abandonRestore(id: string): Promise<void> {
    const target = checkpointById(id)
    if (!target || !target.restore || target.restore.finishedAt !== null) return
    const next: Checkpoint = deepToPlain({ ...target, restore: null })
    await db.checkpoints.put(next)
    persistLocal(next)
  }

  return {
    checkpoints,
    hydrated,
    restoring,
    sortedCheckpoints,
    currentCheckpoint,
    pendingRestoreCheckpoint,
    checkpointById,
    hydrate,
    createCheckpoint,
    removeCheckpoint,
    startRestore,
    runPendingRestore,
    abandonRestore
  }
})

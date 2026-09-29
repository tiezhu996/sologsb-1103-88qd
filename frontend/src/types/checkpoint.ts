import type { Session } from '@/types/session'
import type { Fixture } from '@/types/fixture'
import type { Cue } from '@/types/cue'
import type { CueLevel } from '@/types/level'

/** 检查点单条记录使用的固定主键（全场只保留一个检查点） */
export const CHECKPOINT_ID = 'cp-current'

/** 恢复检查点时逐块落库、逐块报告成败的四个数据块（顺序即恢复顺序） */
export const CHECKPOINT_PARTS = ['sessions', 'fixtures', 'cues', 'levels'] as const
export type CheckpointPart = (typeof CHECKPOINT_PARTS)[number]

/** 各数据块在界面上的名称 */
export const PART_LABELS: Record<CheckpointPart, string> = {
  sessions: '场次',
  fixtures: '通道配接',
  cues: 'Cue 顺序与过渡',
  levels: '通道电平'
}

/** 单个数据块的恢复状态 */
export type CheckpointPartStatus = 'pending' | 'success' | 'failed'

export interface CheckpointPartState {
  status: CheckpointPartStatus
  /** 最近一次失败原因，成功或未尝试时为 null */
  error: string | null
  /** 该块已尝试恢复的次数（含成功的一次） */
  attempts: number
  updatedAt: number
}

/** 检查点恢复生命周期状态 */
export type CheckpointStatus = 'available' | 'restoring'

/** 检查点创建时保存的整台演出快照（不含排演表，排演表始终保留） */
export interface CheckpointSnapshot {
  sessions: Session[]
  fixtures: Fixture[]
  cues: Cue[]
  levels: CueLevel[]
}

/**
 * 联排检查点（Checkpoint）：联排前为整场留一个可恢复点。
 * 恢复按场次 / 通道配接 / Cue / 电平四块分别落库，任一块失败都会保留待处理记录。
 */
export interface Checkpoint {
  /** 主键，固定为 CHECKPOINT_ID */
  id: string
  /** 检查点说明，例如「联排前检查点 · 2026-09-29 19:00」 */
  label: string
  /** 创建时间戳（毫秒） */
  createdAt: number
  /** 最近一次全部恢复成功的时间戳，从未成功恢复过时为 null */
  lastRestoredAt: number | null
  /** available：可恢复；restoring：上次恢复未完成，待继续或放弃 */
  status: CheckpointStatus
  /** 当前这轮恢复的开始时间戳；恢复完成或放弃后为 null */
  restoreStartedAt: number | null
  /** 最近一次整体恢复（首次开始恢复）的开始时间戳，用于界定排演表是否「来自恢复前」 */
  lastRestoreStartedAt: number | null
  /** 四个数据块各自的恢复状态 */
  parts: Record<CheckpointPart, CheckpointPartState>
  /** 整台演出快照 */
  snapshot: CheckpointSnapshot
}

/** 单个数据块本次执行结果 */
export interface RestorePartResult {
  part: CheckpointPart
  ok: boolean
  error: string | null
}

/** 一次恢复（含继续恢复）执行完四个块后的汇总结果 */
export interface RestoreResult {
  /** 四个块是否全部成功；false 时页面不得展示为恢复完成 */
  completed: boolean
  parts: RestorePartResult[]
  /** 未成功的数据块列表 */
  failedParts: CheckpointPart[]
}

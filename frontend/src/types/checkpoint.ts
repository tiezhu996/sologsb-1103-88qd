import type { Cue } from '@/types/cue'
import type { CueLevel } from '@/types/level'
import type { Fixture } from '@/types/fixture'
import type { Session } from '@/types/session'

/** 恢复时逐块落库的数据单元；顺序即依赖顺序（父表在前） */
export const RESTORE_PARTS = ['sessions', 'fixtures', 'cues', 'levels'] as const
export type RestorePart = (typeof RESTORE_PARTS)[number]

/** 恢复结束后还要给检查点之后生成的排演表补标，作为独立的一块追踪 */
export const SHEET_MARK_PART = 'sheetMark' as const
export type RestoreStep = RestorePart | typeof SHEET_MARK_PART

/** 每块 / 每一步的执行状态 */
export type RestorePartStatus = 'pending' | 'failed' | 'done'

/** 数据块中文名，用于「哪一块没成功」的提示 */
export const RESTORE_PART_LABELS: Record<RestoreStep, string> = {
  sessions: '场次信息',
  fixtures: '灯位通道配接',
  cues: 'Cue 与顺序过渡',
  levels: '通道电平',
  sheetMark: '排演表来源标注'
}

/** 检查点建立时刻的整场快照（恢复时把各表整体换回该状态） */
export interface CheckpointSnapshot {
  sessions: Session[]
  fixtures: Fixture[]
  cues: Cue[]
  levels: CueLevel[]
}

/** 一次恢复的进度记录：每块独立持久化，页面重开后可继续 */
export interface RestoreState {
  /** 恢复启动时间（ISO 字符串） */
  startedAt: string
  /** 完成时间；全部块（含排演表标注）成功后才写入 */
  finishedAt: string | null
  /** 各数据块的状态 */
  parts: Record<RestorePart, RestorePartStatus>
  /** 检查点之后生成的排演表补标状态（独立追踪，不影响已换回的数据块） */
  sheetMark: {
    status: RestorePartStatus
    error: string | null
  }
  /** 最近一次失败的块与错误信息，供页面与重开横幅展示 */
  lastError: { part: RestoreStep; message: string } | null
}

/**
 * 联排检查点（Checkpoint）：联排前保存整场（场次 / 通道配接 / Cue / 电平）的快照。
 * 现场改乱后可从检查点恢复；恢复进度记录在 restore 字段中，未完成时随库持久化。
 */
export interface Checkpoint {
  /** 主键 */
  id: string
  /** 舞台监督填写的检查点名称，例如「联排前 · 9 月 29 日 18:40」 */
  label: string
  /** 备注 */
  note: string
  /** 建立时间（ISO 字符串），恢复时据此判断哪些排演表是「恢复前」生成的 */
  createdAt: string
  /** 建立时刻的整场快照 */
  snapshot: CheckpointSnapshot
  /** 快照中的数据条数，供列表展示 */
  counts: {
    sessions: number
    fixtures: number
    cues: number
    levels: number
  }
  /** 未完成 / 已完成的恢复进度；没有恢复记录时为 null */
  restore: RestoreState | null
}

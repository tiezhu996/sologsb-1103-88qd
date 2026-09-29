/**
 * 检查点恢复流程的端到端验证（纯 Node，fake-indexeddb 模拟 IndexedDB）。
 * 运行方式（仅验证时临时安装，不写入 package.json）：
 *   npm i --no-save fake-indexeddb tsx
 *   npx tsx scripts/verify-checkpoint.ts
 *
 * 覆盖：创建检查点 → 改乱数据（删场级联）→ 恢复中某块故障 → 逐块结果 → 保持 restoring
 *      → 排演表保留与「恢复前」标注 → 继续恢复成功 → 重开页面识别待处理记录
 *      → 放弃 → 再次整体恢复 → 旧库无检查点数据照常打开。
 */
import 'fake-indexeddb/auto'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionStore } from '@/stores/sessionStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useCueStore } from '@/stores/cueStore'
import { useLevelStore } from '@/stores/levelStore'
import { useSheetStore } from '@/stores/sheetStore'
import { useCheckpointStore } from '@/stores/checkpointStore'
import { createEmptySessionDraft } from '@/types/session'
import { createEmptyFixtureDraft } from '@/types/fixture'
import { createEmptyCueDraft } from '@/types/cue'
import { db } from '@/utils/db'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('❌ FAIL:', msg)
    process.exitCode = 1
  } else {
    console.log('✅', msg)
  }
}

async function main() {
  setActivePinia(createPinia())
  const sessions = useSessionStore()
  const fixtures = useFixtureStore()
  const cues = useCueStore()
  const levels = useLevelStore()
  const sheets = useSheetStore()
  const checkpoints = useCheckpointStore()

  await Promise.all([sessions.hydrate(), fixtures.hydrate(), cues.hydrate(), levels.hydrate(), sheets.hydrate(), checkpoints.hydrate()])

  // 1. 造基线数据
  const s1 = await sessions.createSession({ ...createEmptySessionDraft(1), title: '第一幕' })
  const f1 = (await fixtures.addFixture({ ...createEmptyFixtureDraft(s1.id, 1) })).fixture!
  const c1 = await cues.addCue({ ...createEmptyCueDraft(s1.id, 'Q1') })
  await levels.upsertLevel(c1.id, f1.id, { intensity: 80, colorTempK: 3200 })
  assert(sessions.sessions.length === 1, '基线：1 场')
  assert(fixtures.fixtures.length === 1, '基线：1 通道')
  assert(cues.cues.length === 1, '基线：1 Cue')
  assert(levels.levels.length === 1 && levels.levels[0].intensity === 80, '基线：电平 80%')

  // 2. 创建检查点
  const cp = await checkpoints.createCheckpoint('联排前')
  assert(cp !== null && checkpoints.hasCheckpoint && cp!.status === 'available', '检查点已创建、状态 available')
  const cpCreatedAt = cp!.createdAt

  // 3. 改乱现场：删场（级联清通道/Cue/电平），并新建一堆东西
  await sessions.createSession({ ...createEmptySessionDraft(2), title: '第二幕-改乱' })
  await sessions.removeSession(s1.id)
  assert(sessions.sessions.length === 1 && cues.cues.length === 0 && fixtures.fixtures.length === 0 && levels.levels.length === 0, '现场已改乱：基线数据被删')

  // 检查点之后、恢复之前生成一张排演表（此时 cues 为空无法生成，直接构造一张历史表）
  const preRestoreTime = new Date().toISOString()
  const sheetRecord: import('@/types/sheet').RehearsalSheet = {
    id: 'sheet_pre',
    sessionId: 'ghost',
    sheetNo: 'RS-PRE',
    generatedAt: preRestoreTime,
    includedCueIds: [],
    note: '恢复前生成',
    cueLines: []
  }
  await db.sheets.put(sheetRecord)
  await sheets.hydrate()
  assert(checkpoints.isSheetFromBeforeRestore(preRestoreTime) === false, '恢复尚未开始：暂不标注恢复前')

  // 留出时间间隔，保证排演表时间严格早于恢复开始时间
  await new Promise((resolve) => setTimeout(resolve, 5))

  // 4. 故障注入：恢复到 cues 块时 bulkPut 抛错一次（clear 已执行），随后恢复
  const origBulkPut = db.cues.bulkPut.bind(db.cues)
  ;(db.cues as any).bulkPut = async (...args: unknown[]) => {
    if (failures > 0) {
      failures--
      throw new Error('模拟磁盘故障:cues')
    }
    return origBulkPut(...(args as [never]))
  }
  failures = 1

  const result1 = await checkpoints.startRestore()
  assert(result1 !== null && result1!.completed === false, '有块失败：整体不算恢复完成')
  assert(result1!.parts.find((p) => p.part === 'sessions')?.ok === true, '场次块成功')
  assert(result1!.parts.find((p) => p.part === 'fixtures')?.ok === true, '通道块成功')
  assert(result1!.parts.find((p) => p.part === 'cues')?.ok === false, 'Cue 块失败并返回原因')
  assert(result1!.failedParts.includes('cues'), 'failedParts 点名 Cue')
  assert(checkpoints.checkpoint?.status === 'restoring', '检查点保持 restoring（待处理记录）')
  assert(sessions.sessions.length === 1 && sessions.sessions[0].title === '第一幕', '场次已换回')
  assert(fixtures.fixtures.length === 1, '通道已换回')
  assert(cues.cues.length === 0, 'Cue 块失败：表仍是空（clear 后写入失败）')
  // 电平块独立于 Cue 块仍会执行：清空后写回快照电平（IndexedDB 无外键约束，Cue 尚未换回时也能写入）
  assert(levels.levels.length === 1 && levels.levels[0].intensity === 80, '电平块照常执行，已按快照写入')

  // 5. 排演表保留 + 标注：恢复前那张还在；恢复一旦开始即应被标注（即便未全部成功）
  assert(sheets.sheets.some((s) => s.id === 'sheet_pre'), '恢复前生成的排演表保留')
  assert(checkpoints.isSheetFromBeforeRestore(preRestoreTime) === true, '恢复开始后：恢复前排演表即被标注')
  assert(checkpoints.isSheetFromBeforeRestore(new Date(cpCreatedAt - 10000).toISOString()) === false, '检查点之前的表不标注')

  // 6. 继续恢复（故障已解除）：跳过成功块，重放 cues、levels
  const result2 = await checkpoints.continueRestore()
  assert(result2 !== null && result2!.completed === true, '继续恢复后全部成功')
  assert(result2!.parts.filter((p) => p.ok).length === 4, '四块均成功（含跳过的成功块）')
  assert(checkpoints.checkpoint?.status === 'available', '状态回到 available')
  assert(checkpoints.checkpoint?.lastRestoredAt !== null, '记录恢复完成时间')
  assert(cues.cues.length === 1 && cues.cues[0].cueNo === 'Q1', 'Cue 已换回 Q1')
  assert(levels.levels.length === 1 && levels.levels[0].intensity === 80, '电平已换回 80%')
  assert(sessions.sessions.length === 1, '改乱时新建的第二幕未带回（快照只有第一幕）')

  // 7. 恢复后再生成的表不标注
  assert(checkpoints.isSheetFromBeforeRestore(new Date().toISOString()) === false, '恢复后生成的表不标注')

  // 8. 模拟“重开页面”：重新 hydrate 检查点
  const pinia2 = createPinia()
  setActivePinia(pinia2)
  const cp2 = useCheckpointStore()
  await cp2.hydrate()
  assert(cp2.checkpoint?.status === 'available', '重开页面：无待处理记录（正常打开）')

  // 9. 放弃流程：制造第二次失败 -> restoring -> 放弃 -> available
  const piniaB = createPinia()
  setActivePinia(piniaB)
  const cpB = useCheckpointStore()
  await cpB.hydrate()
  const ssB = useSessionStore(); await ssB.hydrate()
  const fx2 = useFixtureStore(); await fx2.hydrate()
  const cu2 = useCueStore(); await cu2.hydrate()
  const lv2 = useLevelStore(); await lv2.hydrate()
  const sh2 = useSheetStore(); await sh2.hydrate()

  // levels 块永久失败
  const origLevelsPut = db.levels.bulkPut.bind(db.levels)
  ;(db.levels as any).bulkPut = async (..._args: unknown[]) => {
    throw new Error('磁盘只读:levels')
  }
  const r3 = await cpB.startRestore()
  assert(r3!.completed === false && r3!.failedParts.join() === 'levels', '第二次恢复仅电平块失败')
  assert(cpB.checkpoint?.status === 'restoring', '状态 restoring')

  // 重开：新 pinia hydrate 应看到待处理记录
  const piniaC = createPinia()
  setActivePinia(piniaC)
  const cpC = useCheckpointStore()
  await cpC.hydrate()
  assert(cpC.checkpoint?.status === 'restoring' && cpC.failedParts.join() === 'levels', '重开页面可见待处理记录（levels）')

  await cpC.discardPendingRestore()
  assert(cpC.checkpoint?.status === 'available' && cpC.failedParts.length === 4, '放弃后状态 available，分块状态重置')

  // 恢复 levels 写入能力后，检查点仍可再次整体恢复
  ;(db.levels as any).bulkPut = origLevelsPut
  const r4 = await cpC.startRestore()
  assert(r4!.completed === true, '放弃后可重新整体恢复并成功')
  const lvFinal = useLevelStore()
  await lvFinal.hydrate()
  assert(lvFinal.levels.length === 1 && lvFinal.levels[0].intensity === 80, '电平最终为快照值 80%')

  // 10. 旧库兼容：checkpoints 表在 v3 升级后存在；删掉记录模拟「旧库无检查点数据」
  await db.checkpoints.clear()
  const piniaD = createPinia()
  setActivePinia(piniaD)
  const cpD = useCheckpointStore()
  await cpD.hydrate()
  assert(cpD.checkpoint === null && cpD.isRestoring === false, '旧库无检查点数据时照常打开（不弹待处理记录）')
  assert((await db.checkpoints.toArray()).length === 0, 'checkpoints 表结构在 v3 下可正常读写')

  console.log('\n全部验证通过')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

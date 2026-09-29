<script setup lang="ts">
import { computed, ref } from 'vue'
import { NAlert, NButton, NInput, NModal, NTag, useDialog, useMessage } from 'naive-ui'
import CheckpointPartsView from '@/components/common/CheckpointPartsView.vue'
import { useCheckpointStore } from '@/stores/checkpointStore'
import { PART_LABELS } from '@/types/checkpoint'
import type { RestoreResult } from '@/types/checkpoint'
import { formatDateTime } from '@/utils/fade'

/**
 * CheckpointPanel：联排前检查点的创建 / 恢复 / 继续 / 放弃。
 * 恢复按四块分别落库并逐块报告；任一块失败都保持「恢复未完成」，不会展示成恢复完成。
 */
const message = useMessage()
const dialog = useDialog()
const checkpointStore = useCheckpointStore()

const busy = ref(false)
const showCreate = ref(false)
const labelDraft = ref('')
/** 本次页面会话内最近一次恢复结果，用于成功 / 失败提示条 */
const lastResult = ref<RestoreResult | null>(null)

const checkpoint = computed(() => checkpointStore.checkpoint)
const counts = computed(() => checkpointStore.snapshotCounts)

function failedLabel(result: RestoreResult): string {
  return result.failedParts.map((part) => PART_LABELS[part]).join('、')
}

function openCreate(): void {
  labelDraft.value = checkpoint.value?.label?.startsWith('联排前检查点') ? '' : checkpoint.value?.label ?? ''
  showCreate.value = true
}

function confirmCreate(): void {
  if (checkpoint.value) {
    dialog.warning({
      title: '重建检查点',
      content: '将用当前的场次、通道配接、Cue 与电平重新生成检查点，旧检查点会被覆盖；已生成的排演表不受影响。',
      positiveText: '覆盖重建',
      negativeText: '取消',
      onPositiveClick: () => doCreate()
    })
    return
  }
  void doCreate()
}

async function doCreate(): Promise<void> {
  busy.value = true
  try {
    const created = await checkpointStore.createCheckpoint(labelDraft.value)
    if (created) {
      message.success('联排前检查点已保存')
      lastResult.value = null
    }
    showCreate.value = false
  } finally {
    busy.value = false
  }
}

function confirmRestore(): void {
  if (!checkpoint.value) return
  dialog.warning({
    title: '恢复检查点',
    content:
      '将把场次、通道配接、Cue 顺序与过渡、通道电平整体换回检查点时的状态；检查点之后生成的排演表会保留并在列表中标注「恢复前」。',
    positiveText: '开始恢复',
    negativeText: '取消',
    onPositiveClick: () => doRestore()
  })
}

async function doRestore(): Promise<void> {
  busy.value = true
  try {
    const result = await checkpointStore.startRestore()
    if (result) reportResult(result)
  } finally {
    busy.value = false
  }
}

async function doContinue(): Promise<void> {
  busy.value = true
  try {
    const result = await checkpointStore.continueRestore()
    if (result) reportResult(result)
  } finally {
    busy.value = false
  }
}

function confirmDiscard(): void {
  dialog.warning({
    title: '放弃未完成的恢复',
    content:
      '待处理记录将被清除、检查点回到可恢复状态；已经换回成功的块保留原样，未成功的块维持当前（可能仍是被改乱的）状态，可之后重新整体恢复。',
    positiveText: '放弃记录',
    negativeText: '取消',
    onPositiveClick: async () => {
      busy.value = true
      try {
        await checkpointStore.discardPendingRestore()
        lastResult.value = null
        message.info('已放弃未完成的恢复记录')
      } finally {
        busy.value = false
      }
    }
  })
}

function confirmRemove(): void {
  dialog.warning({
    title: '删除检查点',
    content: '将删除联排前检查点及其快照，不影响当前的场次、Cue、通道电平与排演表，且无法再恢复到该检查点。',
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      busy.value = true
      try {
        await checkpointStore.removeCheckpoint()
        lastResult.value = null
        message.success('检查点已删除')
      } finally {
        busy.value = false
      }
    }
  })
}

/** 根据四块结果给反馈：全部成功才算恢复完成，否则逐块点名失败项 */
function reportResult(result: RestoreResult): void {
  lastResult.value = result
  if (result.completed) {
    message.success('恢复完成：场次、通道配接、Cue 与通道电平已全部换回')
  } else {
    message.error(`恢复未完成：${failedLabel(result)} 没有换回成功，请查看面板处理`)
  }
}
</script>

<template>
  <section class="panel checkpoint-panel">
    <h2 class="panel__title">
      联排前检查点
      <NTag v-if="checkpoint" size="small" :type="checkpointStore.isRestoring ? 'error' : 'warning'" :bordered="false">
        {{ checkpointStore.isRestoring ? '恢复未完成' : '可恢复' }}
      </NTag>
      <span class="panel__title-tag">恢复时场次 / 通道 / Cue / 电平一起换回，排演表保留</span>
    </h2>

    <template v-if="!checkpoint">
      <p class="checkpoint-panel__desc">
        联排前为整场留一个检查点。现场把 Cue 顺序、过渡、通道配接或电平改乱后，可以整体换回检查点时的状态。
      </p>
      <NButton type="primary" :loading="busy" @click="openCreate">保存联排前检查点</NButton>
    </template>

    <template v-else>
      <div class="checkpoint-panel__meta">
        <div class="checkpoint-meta">
          <span class="checkpoint-meta__label">检查点说明</span>
          <span class="checkpoint-meta__value">{{ checkpoint.label }}</span>
        </div>
        <div class="checkpoint-meta">
          <span class="checkpoint-meta__label">保存于</span>
          <span class="checkpoint-meta__value mono">{{ formatDateTime(checkpoint.createdAt) }}</span>
        </div>
        <div class="checkpoint-meta">
          <span class="checkpoint-meta__label">最近恢复</span>
          <span class="checkpoint-meta__value mono">
            {{ checkpoint.lastRestoredAt ? formatDateTime(checkpoint.lastRestoredAt) : '尚未恢复过' }}
          </span>
        </div>
        <div class="checkpoint-meta">
          <span class="checkpoint-meta__label">快照内容</span>
          <span class="checkpoint-meta__value mono">
            {{ counts.sessions }} 场 · {{ counts.fixtures }} 通道 · {{ counts.cues }} Cue · {{ counts.levels }} 电平
          </span>
        </div>
      </div>

      <NAlert
        v-if="checkpointStore.isRestoring"
        type="error"
        :show-icon="true"
        :bordered="false"
        class="checkpoint-panel__alert"
        title="上次恢复未完成"
      >
        <template v-if="checkpoint.restoreStartedAt">
          开始于 {{ formatDateTime(checkpoint.restoreStartedAt) }}。可继续恢复未成功的块，或放弃待处理记录。
        </template>
        <CheckpointPartsView class="checkpoint-panel__parts" :checkpoint="checkpoint" />
        <div class="checkpoint-panel__btns checkpoint-panel__btns--alert">
          <NButton size="small" type="primary" :loading="busy" @click="doContinue">继续恢复</NButton>
          <NButton size="small" quaternary :disabled="busy" @click="confirmDiscard">放弃</NButton>
        </div>
      </NAlert>

      <NAlert
        v-else-if="lastResult && lastResult.completed"
        type="success"
        :show-icon="true"
        :bordered="false"
        class="checkpoint-panel__alert"
        title="恢复完成"
      >
        场次、通道配接、Cue 顺序与过渡、通道电平已全部换回检查点时的状态。
      </NAlert>

      <NAlert
        v-else-if="lastResult"
        type="error"
        :show-icon="true"
        :bordered="false"
        class="checkpoint-panel__alert"
        :title="`恢复未完成：${failedLabel(lastResult)} 未换回成功`"
      >
        <p class="checkpoint-panel__alert-desc">其余块已换回，页面不会按恢复完成处理。可继续重试未成功的块。</p>
        <CheckpointPartsView class="checkpoint-panel__parts" :checkpoint="checkpoint" />
        <div class="checkpoint-panel__btns checkpoint-panel__btns--alert">
          <NButton size="small" type="primary" :loading="busy" @click="doContinue">继续恢复</NButton>
          <NButton size="small" quaternary :disabled="busy" @click="confirmDiscard">放弃</NButton>
        </div>
      </NAlert>

      <div class="checkpoint-panel__btns">
        <NButton
          v-if="!checkpointStore.isRestoring"
          type="primary"
          :loading="busy"
          @click="confirmRestore"
        >
          恢复到此检查点
        </NButton>
        <NButton :disabled="busy" @click="openCreate">重建检查点</NButton>
        <NButton quaternary type="error" :disabled="busy" @click="confirmRemove">删除</NButton>
      </div>
    </template>

    <NModal v-model:show="showCreate" preset="card" title="保存联排前检查点" class="checkpoint-create-modal" :mask-closable="false">
      <p class="checkpoint-create-modal__desc">
        将快照当前的场次、灯位通道配接、Cue 顺序与过渡、通道电平；排演表不进快照，恢复后依然保留。
      </p>
      <NInput
        v-model:value="labelDraft"
        placeholder="留空则使用「联排前检查点 · 当前时间」"
        maxlength="40"
        show-count
      />
      <template #footer>
        <div class="checkpoint-create-modal__footer">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="busy" @click="confirmCreate">保存检查点</NButton>
        </div>
      </template>
    </NModal>
  </section>
</template>

<style scoped>
.checkpoint-panel__desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.55);
  max-width: 760px;
}

.checkpoint-panel__meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
}

.checkpoint-meta {
  display: flex;
  gap: 10px;
  font-size: 13px;
}

.checkpoint-meta__label {
  width: 84px;
  flex: none;
  color: rgba(255, 255, 255, 0.42);
}

.checkpoint-meta__value {
  color: rgba(255, 255, 255, 0.82);
}

.checkpoint-panel__alert {
  margin-bottom: 14px;
}

.checkpoint-panel__alert-desc {
  margin: 0 0 10px;
  font-size: 13px;
}

.checkpoint-panel__parts {
  margin-top: 10px;
}

.checkpoint-panel__btns {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.checkpoint-panel__btns--alert {
  margin-top: 12px;
}

.checkpoint-create-modal {
  width: 480px;
  max-width: 92vw;
}

.checkpoint-create-modal__desc {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.55);
}

.checkpoint-create-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>

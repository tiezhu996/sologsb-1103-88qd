<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import {
  NAlert,
  NButton,
  NDescriptions,
  NDescriptionsItem,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NPopconfirm,
  NStep,
  NSteps,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import BlankHint from '@/components/common/BlankHint.vue'
import { RESTORE_PARTS, RESTORE_PART_LABELS, SHEET_MARK_PART, type Checkpoint } from '@/types/checkpoint'
import { useCheckpointStore } from '@/stores/checkpointStore'
import { formatDateTime } from '@/utils/fade'

const message = useMessage()
const dialog = useDialog()
const checkpointStore = useCheckpointStore()

const showCreate = ref(false)
const creating = ref(false)
const createForm = reactive({ label: '', note: '' })

const checkpoint = computed<Checkpoint | null>(() => checkpointStore.currentCheckpoint)
const pendingRestore = computed(() => checkpointStore.pendingRestoreCheckpoint)

/** 恢复结论（未完成时保留在页面上，明确显示「哪一块没成功」） */
const lastOutcome = ref<{ finished: boolean; message: string } | null>(null)

const restoreSteps = computed<Array<{ key: string; title: string; status: 'pending' | 'failed' | 'done' }>>(() => {
  const restore = checkpoint.value?.restore
  if (!restore) return []
  const steps: Array<{ key: string; title: string; status: 'pending' | 'failed' | 'done' }> = RESTORE_PARTS.map((part) => ({
    key: part,
    title: RESTORE_PART_LABELS[part],
    status: restore.parts[part]
  }))
  steps.push({
    key: SHEET_MARK_PART,
    title: RESTORE_PART_LABELS[SHEET_MARK_PART],
    status: restore.sheetMark.status
  })
  return steps
})

function stepStatus(status: 'pending' | 'failed' | 'done'): 'wait' | 'process' | 'finish' | 'error' {
  if (status === 'done') return 'finish'
  if (status === 'failed') return 'error'
  return 'wait'
}

function openCreate(): void {
  createForm.label = ''
  createForm.note = ''
  showCreate.value = true
}

async function submitCreate(): Promise<void> {
  creating.value = true
  try {
    const created = await checkpointStore.createCheckpoint(createForm.label, createForm.note)
    message.success(`已建立检查点「${created.label}」，整场的 Cue、通道配接与电平均已存档`)
    showCreate.value = false
  } catch (error) {
    message.error(error instanceof Error ? error.message : '检查点建立失败')
  } finally {
    creating.value = false
  }
}

/** 先确认，再初始化进度记录并立即开始逐块恢复 */
async function confirmRestore(): Promise<void> {
  const target = checkpoint.value
  if (!target || checkpointStore.restoring) return
  const proceed = async (): Promise<void> => {
    try {
      await checkpointStore.startRestore(target.id)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '无法开始恢复')
      return
    }
    await executeRestore(target.id)
  }

  if (pendingRestore.value?.id === target.id) {
    await proceed()
    return
  }
  dialog.warning({
    title: '从检查点恢复',
    content:
      '将把整场的场次信息、Cue 顺序与过渡、灯位通道配接、通道电平整体换回检查点时的状态；' +
      '检查点之后生成的排演表会保留，并在列表中注明「来自恢复前」。恢复按块执行，任一块没成功都会明确告知，不会显示为恢复完成。',
    positiveText: '开始恢复',
    negativeText: '取消',
    onPositiveClick: proceed
  })
}

async function executeRestore(id: string): Promise<void> {
  lastOutcome.value = null
  const outcome = await checkpointStore.runPendingRestore(id)
  lastOutcome.value = { finished: outcome.finished, message: outcome.message }
  if (outcome.finished) message.success(outcome.message)
  else message.error(outcome.message)
}

async function continueRestore(): Promise<void> {
  if (!pendingRestore.value || checkpointStore.restoring) return
  await executeRestore(pendingRestore.value.id)
}

function confirmAbandon(): void {
  if (!pendingRestore.value) return
  dialog.warning({
    title: '放弃未完成的恢复',
    content: '将清除这条待处理恢复记录；已经换回成功的数据块保持现状，不会回退。检查点仍保留，之后可重新发起恢复。',
    positiveText: '确认放弃',
    negativeText: '继续恢复',
    onPositiveClick: async () => {
      await checkpointStore.abandonRestore(pendingRestore.value!.id)
      lastOutcome.value = null
      message.info('已放弃本次恢复')
    }
  })
}

async function removeCheckpoint(): Promise<void> {
  if (!checkpoint.value) return
  try {
    await checkpointStore.removeCheckpoint(checkpoint.value.id)
    lastOutcome.value = null
    message.success('检查点已删除')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '删除失败')
  }
}
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">联排检查点</h1>
        <p class="page__subtitle">
          联排前为整场留一个检查点；现场把 Cue 顺序、过渡、通道配接或电平改乱后可整体换回。
          恢复按「场次信息 / Cue 与顺序过渡 / 灯位通道配接 / 通道电平」逐块执行，哪一块没成功都会明确告知。
        </p>
      </div>
      <div class="page__actions">
        <NButton type="primary" @click="openCreate">
          {{ checkpoint ? '重新建立检查点' : '联排前建立检查点' }}
        </NButton>
      </div>
    </header>

    <BlankHint
      v-if="!checkpoint"
      title="还没有联排检查点"
      description="联排开始前建立检查点，把当前的场次、Cue 顺序与过渡、通道配接和电平整体存档；现场改乱后可逐块换回。"
      tip="检查点保存在浏览器本地（IndexedDB）。旧数据升级后默认没有检查点，页面可照常使用。"
      action-text="联排前建立检查点"
      @action="openCreate"
    />

    <template v-else>
      <NAlert v-if="pendingRestore" type="warning" :show-icon="true" title="有一场恢复尚未完成">
        <p class="alert-line">
          恢复于 {{ formatDateTime(pendingRestore.restore!.startedAt) }} 启动，尚未全部完成。已成功的块保持换回后的状态；
          请处理问题后「继续恢复」，或「放弃」清除待处理记录。在此之前系统不会把它显示为恢复完成。
        </p>
        <div class="alert-actions">
          <NButton type="warning" size="small" :loading="checkpointStore.restoring" @click="continueRestore">继续恢复</NButton>
          <NButton size="small" :disabled="checkpointStore.restoring" @click="confirmAbandon">放弃</NButton>
        </div>
      </NAlert>

      <NAlert v-else-if="checkpoint.restore?.finishedAt" type="success" :show-icon="true" title="检查点已成功恢复过一次">
        <p class="alert-line">
          恢复完成于 {{ formatDateTime(checkpoint.restore.finishedAt) }}。检查点仍保留，若现场再次改乱，可再次从此检查点恢复。
        </p>
      </NAlert>

      <section class="panel">
        <div class="cp-head">
          <h2 class="panel__title">
            当前检查点
            <span class="panel__title-tag">整场唯一</span>
          </h2>
          <NPopconfirm @positive-click="removeCheckpoint">
            <template #trigger>
              <NButton size="small" quaternary type="error" :disabled="!!pendingRestore">删除检查点</NButton>
            </template>
            删除后无法再从该检查点恢复，已恢复的数据不受影响。确认删除？
          </NPopconfirm>
        </div>

        <NDescriptions label-placement="left" bordered :column="1" size="small">
          <NDescriptionsItem label="名称">{{ checkpoint.label }}</NDescriptionsItem>
          <NDescriptionsItem label="建立时间">{{ formatDateTime(checkpoint.createdAt) }}</NDescriptionsItem>
          <NDescriptionsItem label="存档内容">
            <NTag size="small" :bordered="false">{{ checkpoint.counts.sessions }} 个场次</NTag>
            <NTag size="small" :bordered="false" type="info">{{ checkpoint.counts.cues }} 条 Cue</NTag>
            <NTag size="small" :bordered="false" type="info">{{ checkpoint.counts.fixtures }} 个通道配接</NTag>
            <NTag size="small" :bordered="false" type="info">{{ checkpoint.counts.levels }} 条通道电平</NTag>
          </NDescriptionsItem>
          <NDescriptionsItem label="备注">{{ checkpoint.note || '—' }}</NDescriptionsItem>
        </NDescriptions>

        <div class="cp-actions">
          <NButton
            type="primary"
            :loading="checkpointStore.restoring"
            @click="pendingRestore ? continueRestore() : confirmRestore()"
          >
            {{ pendingRestore ? '继续恢复' : '从此检查点恢复' }}
          </NButton>
          <NButton v-if="pendingRestore" :disabled="checkpointStore.restoring" @click="confirmAbandon">放弃恢复</NButton>
          <span class="muted cp-actions__tip">恢复不删除排演表；检查点之后生成的排演表保留并标注「来自恢复前」</span>
        </div>
      </section>

      <section v-if="checkpoint.restore" class="panel">
        <h2 class="panel__title">
          恢复进度
          <span class="panel__title-tag">
            {{ pendingRestore ? '未完成' : `已完成 · ${formatDateTime(checkpoint.restore.finishedAt ?? '')}` }}
          </span>
        </h2>
        <NSteps :current="0" size="small">
          <NStep
            v-for="item in restoreSteps"
            :key="item.key"
            :status="stepStatus(item.status)"
            :title="item.title"
            :description="item.status === 'done' ? '已换回' : item.status === 'failed' ? '没成功' : '待处理'"
          />
        </NSteps>

        <div v-if="pendingRestore?.restore?.lastError" class="cp-error">
          <p class="cp-error__title">没成功的一块：{{ RESTORE_PART_LABELS[pendingRestore.restore.lastError!.part] }}</p>
          <p class="cp-error__detail">{{ pendingRestore.restore.lastError!.message }}</p>
          <p class="cp-error__hint">本场数据未整体换回，页面不会显示恢复完成；可在排查存储问题后点击「继续恢复」。</p>
        </div>
      </section>

      <NAlert
        v-if="lastOutcome"
        :type="lastOutcome.finished ? 'success' : 'error'"
        :show-icon="true"
        :title="lastOutcome.finished ? '恢复完成' : '恢复未完成'"
        class="cp-outcome"
      >
        {{ lastOutcome.message }}
      </NAlert>
    </template>

    <NModal v-model:show="showCreate" preset="card" title="联排前建立检查点" class="form-modal" :mask-closable="false">
      <NForm label-placement="left" label-width="72">
        <NFormItem label="名称">
          <NInput v-model:value="createForm.label" placeholder="例如：联排前 · 9 月 29 日 18:40" maxlength="60" show-count />
        </NFormItem>
        <NFormItem label="备注">
          <NInput v-model:value="createForm.note" type="textarea" :rows="3" placeholder="存档时的舞台状态、当班人员等说明（可选）" />
        </NFormItem>
      </NForm>
      <template #footer>
        <div class="modal-footer">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="creating" @click="submitCreate">
            {{ checkpoint ? '取代旧检查点并建立' : '建立检查点' }}
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.alert-line {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
}

.alert-actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}

.cp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.cp-head .panel__title {
  margin-bottom: 12px;
}

.cp-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 16px;
}

.cp-actions__tip {
  font-size: 12px;
}

.cp-error {
  margin-top: 16px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(232, 84, 84, 0.08);
  border: 1px solid rgba(232, 84, 84, 0.28);
}

.cp-error__title {
  margin: 0;
  font-size: 13px;
  color: #ff9a9a;
  font-weight: 600;
}

.cp-error__detail {
  margin: 6px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.72);
  line-height: 1.7;
}

.cp-error__hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
  line-height: 1.7;
}

.cp-outcome {
  margin-top: 2px;
}

.form-modal {
  width: 520px;
  max-width: 92vw;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>

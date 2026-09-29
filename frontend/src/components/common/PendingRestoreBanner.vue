<script setup lang="ts">
import { computed } from 'vue'
import { NAlert, NButton, NButtonGroup, NTag, useMessage } from 'naive-ui'
import { RESTORE_PARTS, RESTORE_PART_LABELS } from '@/types/checkpoint'
import { useCheckpointStore } from '@/stores/checkpointStore'
import { formatDateTime } from '@/utils/fade'

const emit = defineEmits<{ (event: 'detail'): void }>()

const checkpointStore = useCheckpointStore()
const message = useMessage()

const pending = computed(() => checkpointStore.pendingRestoreCheckpoint)

const partStatuses = computed(() => {
  const restore = pending.value?.restore
  if (!restore) return []
  return RESTORE_PARTS.map((part) => ({
    part,
    label: RESTORE_PART_LABELS[part],
    status: restore.parts[part]
  }))
})

const failedEntry = computed(() => {
  const restore = pending.value?.restore
  if (!restore || !restore.lastError) return null
  return {
    label: RESTORE_PART_LABELS[restore.lastError.part],
    reason: restore.lastError.message
  }
})

const sheetMarkFailed = computed(() => pending.value?.restore?.sheetMark.status === 'failed')

async function continueRestore(): Promise<void> {
  if (!pending.value || checkpointStore.restoring) return
  const outcome = await checkpointStore.runPendingRestore(pending.value.id)
  if (outcome.finished) message.success(outcome.message)
  else message.error(outcome.message)
}

async function abandon(): Promise<void> {
  if (!pending.value) return
  await checkpointStore.abandonRestore(pending.value.id)
  message.info('已放弃本次恢复；已换回的数据保持现状，检查点仍保留，可之后重新发起恢复。')
}
</script>

<template>
  <NAlert
    v-if="pending"
    type="warning"
    :show-icon="true"
    class="pending-banner"
    title="检测到一场未完成的检查点恢复"
  >
    <div class="pending-banner__body">
      <p class="pending-banner__line">
        检查点「{{ pending.label }}」（建立于 {{ formatDateTime(pending.createdAt) }}）的恢复在
        {{ formatDateTime(pending.restore!.startedAt) }} 启动后未全部完成，数据尚未整体换回，请勿当作已恢复使用。
      </p>
      <div class="pending-banner__parts">
        <NTag
          v-for="item in partStatuses"
          :key="item.part"
          size="small"
          :type="item.status === 'done' ? 'success' : item.status === 'failed' ? 'error' : 'default'"
          :bordered="false"
        >
          {{ item.label }}：{{ item.status === 'done' ? '已换回' : item.status === 'failed' ? '失败' : '待处理' }}
        </NTag>
        <NTag size="small" :type="sheetMarkFailed ? 'error' : 'default'" :bordered="false">
          排演表来源标注：{{ pending.restore!.sheetMark.status === 'done' ? '完成' : pending.restore!.sheetMark.status === 'failed' ? '失败' : '待处理' }}
        </NTag>
      </div>
      <p v-if="failedEntry" class="pending-banner__reason">
        没成功的一块：{{ failedEntry.label }}（{{ failedEntry.reason }}）
      </p>
      <p v-else-if="sheetMarkFailed" class="pending-banner__reason">
        没成功的一块：{{ RESTORE_PART_LABELS.sheetMark }}（{{ pending.restore!.sheetMark.error ?? '未知原因' }}）
      </p>
      <div class="pending-banner__actions">
        <NButtonGroup>
          <NButton type="warning" :loading="checkpointStore.restoring" @click="continueRestore">继续恢复</NButton>
          <NButton :disabled="checkpointStore.restoring" @click="abandon">放弃</NButton>
          <NButton quaternary :disabled="checkpointStore.restoring" @click="emit('detail')">查看检查点详情</NButton>
        </NButtonGroup>
      </div>
    </div>
  </NAlert>
</template>

<style scoped>
.pending-banner {
  margin: 16px 26px 0;
  max-width: 1280px;
}

.pending-banner__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pending-banner__line {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
}

.pending-banner__parts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.pending-banner__reason {
  margin: 0;
  font-size: 12px;
  color: #ffb39a;
  line-height: 1.7;
}

.pending-banner__actions {
  display: flex;
}
</style>

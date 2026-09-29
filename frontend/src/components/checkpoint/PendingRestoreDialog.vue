<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAlert, NButton, NModal, NTag, useMessage } from 'naive-ui'
import CheckpointPartsView from '@/components/common/CheckpointPartsView.vue'
import { useCheckpointStore } from '@/stores/checkpointStore'
import { PART_LABELS } from '@/types/checkpoint'
import { formatDateTime } from '@/utils/fade'

/**
 * PendingRestoreDialog：重开页面时，若上次恢复没完成，展示待处理记录，
 * 由舞台监督选择「继续恢复」或「放弃」。旧库没有检查点数据时不弹出。
 */
const message = useMessage()
const checkpointStore = useCheckpointStore()

const show = ref(false)
const busy = ref(false)

const checkpoint = computed(() => checkpointStore.checkpoint)
const failedParts = computed(() => (checkpoint.value ? checkpointStore.failedParts : []))

watch(
  () => checkpointStore.isRestoring,
  (restoring) => {
    // 恢复全部完成或放弃后自动关闭；检测到未完成记录时自动弹出
    show.value = restoring
  },
  { immediate: true }
)

async function handleContinue(): Promise<void> {
  busy.value = true
  try {
    const result = await checkpointStore.continueRestore()
    if (!result) return
    if (result.completed) {
      message.success('恢复完成：场次、通道配接、Cue 与通道电平已全部换回')
      show.value = false
    } else {
      message.error(`恢复未完成：${result.failedParts.map((part) => PART_LABELS[part]).join('、')} 没有换回成功`)
    }
  } finally {
    busy.value = false
  }
}

async function handleDiscard(): Promise<void> {
  busy.value = true
  try {
    await checkpointStore.discardPendingRestore()
    message.info('已放弃未完成的恢复记录')
    show.value = false
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    title="检测到未完成的检查点恢复"
    class="pending-restore-modal"
    :mask-closable="false"
    :closable="false"
  >
    <template v-if="checkpoint">
      <NAlert type="warning" :show-icon="true" :bordered="false" class="pending-restore-modal__alert">
        上次恢复没有全部完成（开始于
        {{ checkpoint.restoreStartedAt ? formatDateTime(checkpoint.restoreStartedAt) : '未知时刻' }}
        ）。已换回成功的块保留成果，未成功的块仍是当前状态。可继续恢复，或放弃待处理记录。
      </NAlert>

      <div class="pending-restore-modal__checkpoint">
        <div class="pending-restore-modal__row">
          <span class="pending-restore-modal__label">检查点</span>
          <span>{{ checkpoint.label }}</span>
        </div>
        <div class="pending-restore-modal__row">
          <span class="pending-restore-modal__label">待处理块</span>
          <span>
            <NTag v-for="part in failedParts" :key="part" size="small" type="error" :bordered="false" class="pending-restore-modal__tag">
              {{ PART_LABELS[part] }}
            </NTag>
          </span>
        </div>
      </div>

      <CheckpointPartsView :checkpoint="checkpoint" />

      <p class="pending-restore-modal__tip">
        排演表在恢复过程中始终保留；检查点之后生成的排演表会在列表中标注「恢复前」。
      </p>
    </template>

    <template #footer>
      <div v-if="checkpoint" class="pending-restore-modal__footer">
        <NButton quaternary type="warning" :loading="busy" @click="handleDiscard">放弃</NButton>
        <NButton type="primary" :loading="busy" @click="handleContinue">继续恢复</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.pending-restore-modal {
  width: 560px;
  max-width: 94vw;
}

.pending-restore-modal__alert {
  margin-bottom: 14px;
}

.pending-restore-modal__checkpoint {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
  font-size: 13px;
}

.pending-restore-modal__row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.pending-restore-modal__label {
  width: 64px;
  flex: none;
  color: rgba(255, 255, 255, 0.42);
}

.pending-restore-modal__tag {
  margin-right: 6px;
}

.pending-restore-modal__tip {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.42);
}

.pending-restore-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>

<script setup lang="ts">
import { computed } from 'vue'
import { NTag } from 'naive-ui'
import type { Checkpoint, CheckpointPart, CheckpointPartStatus } from '@/types/checkpoint'
import { CHECKPOINT_PARTS, PART_LABELS } from '@/types/checkpoint'

/**
 * CheckpointPartsView：检查点四个数据块（场次 / 通道配接 / Cue / 电平）的恢复状态。
 * 检查点面板与「待处理恢复」弹窗共用。
 */
const props = defineProps<{
  checkpoint: Checkpoint
  /** 是否展示失败原因（弹窗默认展开） */
  showErrors?: boolean
}>()

interface PartRow {
  part: CheckpointPart
  label: string
  state: CheckpointPartStatus
  error: string | null
}

const rows = computed<PartRow[]>(() =>
  CHECKPOINT_PARTS.map((part) => ({
    part,
    label: PART_LABELS[part],
    state: props.checkpoint.parts[part].status,
    error: props.checkpoint.parts[part].error
  }))
)

const TAG_TEXT: Record<CheckpointPartStatus, string> = {
  pending: '待恢复',
  success: '已换回',
  failed: '失败'
}

function tagType(status: CheckpointPartStatus): 'default' | 'success' | 'error' {
  if (status === 'success') return 'success'
  if (status === 'failed') return 'error'
  return 'default'
}
</script>

<template>
  <ul class="cp-parts">
    <li v-for="row in rows" :key="row.part" class="cp-parts__item">
      <span class="cp-parts__label">{{ row.label }}</span>
      <NTag size="small" :type="tagType(row.state)" :bordered="false">{{ TAG_TEXT[row.state] }}</NTag>
      <span v-if="showErrors !== false && row.state === 'failed' && row.error" class="cp-parts__error">
        {{ row.error }}
      </span>
    </li>
  </ul>
</template>

<style scoped>
.cp-parts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cp-parts__item {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.cp-parts__label {
  min-width: 132px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.78);
}

.cp-parts__error {
  font-size: 12px;
  color: #ff9a9a;
}
</style>

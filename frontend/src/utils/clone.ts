import { isProxy, toRaw } from 'vue'

/**
 * 深拷贝一份可被结构化克隆（structuredClone / IndexedDB）的纯数据：
 * Vue 响应式 Proxy 不能直接被 structuredClone / IndexedDB 写入，需先逐层 toRaw。
 */
export function deepToPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (isProxy(value)) return deepToPlain(toRaw(value))
  if (Array.isArray(value)) return value.map((item) => deepToPlain(item)) as T
  const result: Record<string, unknown> = {}
  Object.keys(value).forEach((key) => {
    result[key] = deepToPlain((value as Record<string, unknown>)[key])
  })
  return result as T
}

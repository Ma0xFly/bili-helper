import { describe, expect, it } from 'vitest'
import { AiError, errorInfoFrom } from './error'

describe('AiError', () => {
  it('序列化包含 name/kind/message', () => {
    const err = new AiError('network', '请求发不出去')
    expect(err.name).toBe('AiError')
    expect(err.kind).toBe('network')
    expect(err.message).toBe('请求发不出去')
    expect(err.toJSON()).toMatchObject({
      name: 'AiError',
      kind: 'network',
      message: '请求发不出去',
    })
  })

  it('序列化透传 status 与 cause', () => {
    const cause = { reason: 'timeout' }
    const err = new AiError('http', '端点返回非 2xx', { status: 502, cause })
    expect(err.status).toBe(502)
    expect(err.cause).toBe(cause)

    const parsed = JSON.parse(err.serialize())
    expect(parsed).toMatchObject({ kind: 'http', message: '端点返回非 2xx', status: 502 })
    expect(parsed.cause).toEqual(cause)
  })

  it('无 status/cause 时序列化不含 undefined 字段', () => {
    const parsed = JSON.parse(new AiError('config', '还没配置端点').serialize())
    expect(parsed).not.toHaveProperty('status')
    expect(parsed).not.toHaveProperty('cause')
  })

  it('原生 Error cause 归一为 { name, message } 摘要', () => {
    const inner = new Error('底层炸了')
    const err = new AiError('network', '包裹', { cause: inner })
    expect(err.toJSON().cause).toEqual({ name: 'Error', message: '底层炸了' })
    expect(JSON.parse(err.serialize()).cause).toEqual({ name: 'Error', message: '底层炸了' })
  })

  it('环形或 BigInt cause 时 serialize 退回安全摘要而不抛错', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const errors = [
      new AiError('config', '环形', { cause: cyclic }),
      new AiError('auth', 'BigInt', { cause: 1n }),
    ]
    for (const err of errors) {
      const parsed = JSON.parse(err.serialize())
      expect(parsed).toMatchObject({ name: 'AiError', message: err.message })
      expect(parsed.cause).toBeUndefined()
    }
  })
})

describe('errorInfoFrom（SSE end.error 载体）', () => {
  it('AiError 直接投影 kind/message/status', () => {
    expect(errorInfoFrom(new AiError('auth', '端点返回了 401', { status: 401 }))).toEqual({
      kind: 'auth',
      message: '端点返回了 401',
      status: 401,
    })
  })

  it('无 status 的 AiError 不携带 status 字段', () => {
    expect(errorInfoFrom(new AiError('config', '还没配置端点'))).toEqual({
      kind: 'config',
      message: '还没配置端点',
    })
  })

  it('普通 Error 收敛为 network', () => {
    expect(errorInfoFrom(new Error('底层炸了'))).toEqual({ kind: 'network', message: '底层炸了' })
  })

  it('不可字符串化的值（null 原型对象）兜底「未知错误」而非抛 TypeError', () => {
    const weird = Object.create(null) as object
    expect(errorInfoFrom(weird)).toEqual({ kind: 'network', message: '未知错误' })
  })
})
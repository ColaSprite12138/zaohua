// 统一的可预期错误类型：status + code 会原样回给客户端，message 是给人看的
export class HttpError extends Error {
  constructor (status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface FetchJsonRequest {
  id: string
  type: 'fetchJson'
  url: string
  timeoutMs: number
}

export interface CloseRequest {
  id: string
  type: 'close'
}

export type WorkerRequest = FetchJsonRequest | CloseRequest

export interface WorkerResponse {
  id: string
  success: boolean
  data?: any
  error?: string
}


export interface FeeModel {
  maker: number
  taker: number
}

export interface ExchangeMeta {
  name: string
  isHealthy: boolean
  feeModel: FeeModel
} 
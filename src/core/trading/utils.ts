import { RestClientInterface } from '../../adapters/rest/types'
import { AccountStateManager } from '../state/accountStateManager'
import { OrderSide } from '../../types/exchange'
import { OrderInfo } from '../../types/account'
import logger from '../../utils/logger'
import config from '../../utils/config'

/**
 * Place order and monitor for confirmation via account state
 */
export async function placeOrderAndMonitor(
  client: RestClientInterface,
  symbol: string,
  side: OrderSide,
  amount: number,
  price: number,
  isReduceOnly: boolean,
  clientOrderId: string,
  exchange: string,
  accountStateManager: AccountStateManager
): Promise<OrderInfo> {
  // Place the order
  const order = await client.createOrder(symbol, 'MARKET', side, amount, price, isReduceOnly, clientOrderId)
  
  const orderInfo = await monitorOrderConfirmation(order.id, exchange, accountStateManager)

  orderInfo.expectedPrice = price
  orderInfo.exchange = exchange

  return orderInfo
}

/**
 * Monitor order confirmation via account state manager and populate complete OrderInfo
 */
export async function monitorOrderConfirmation(
  orderId: string,
  exchange: string, 
  accountStateManager: AccountStateManager,
): Promise<OrderInfo> {
  const startTime = Date.now()
  
  while (Date.now() - startTime < config.trading.orderConfirmationTimeoutMs) {
    // Check if order is in account state
    const accountOrder = accountStateManager.getOrder(exchange, orderId)
    
    if (accountOrder && accountOrder.status === 'FILLED') {
      logger.debug(`Order ${orderId} confirmed as FILLED`)
      return accountOrder
    }
    
    // Wait before next check
    await delay(100)
  }
  
  // If we reach here, order confirmation timed out
  logger.warn(`Order ${orderId} confirmation timed out`)
  throw new Error(`Order confirmation timeout for ${orderId}`)
}

/**
 * Calculate slippage for an order with proper direction awareness
 */
export function calculateSlippage(orderInfo: OrderInfo, side: OrderSide): { slippageUsd: number, slippagePercent: number } {
  if (!orderInfo.expectedPrice || orderInfo.expectedPrice === 0 || orderInfo.averagePrice === 0) return { slippageUsd: 0, slippagePercent: 0 }
  
  let slippagePercent: number
  
  if (side === 'BUY') {
    // For BUY orders: buying into the ask side
    // Positive slippage means we paid more than expected (bad)
    slippagePercent = ((orderInfo.averagePrice - orderInfo.expectedPrice) / orderInfo.expectedPrice) * 100
  } else {
    // For SELL orders: selling into the bid side
    // Positive slippage means we paid more than expected (bad)
    slippagePercent = ((orderInfo.expectedPrice - orderInfo.averagePrice) / orderInfo.averagePrice) * 100
  }
  
  const slippageUsd = orderInfo.averagePrice * orderInfo.quantity * (slippagePercent / 100)
  
  return { slippageUsd, slippagePercent }
}

/**
 * Calculate fees for an order
 */
export function calculateFees(orderInfo: OrderInfo, feePercent: number): { feesUsd: number, feesPercent: number } {
  const feesUsd = orderInfo.averagePrice * orderInfo.quantity * (feePercent / 100)
  return { feesUsd, feesPercent: feePercent }
}

/**
 * Utility delay function
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
} 
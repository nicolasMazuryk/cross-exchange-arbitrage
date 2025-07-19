import { RestClientInterface } from '../../adapters/rest/types'
import { AccountStateManager } from '../state/accountStateManager'
import { OrderSide, OrderStatus } from '../../types/exchange'
import { OrderInfo } from '../../types/account'
import logger from '../../utils/logger'

/**
 * Place order and monitor for confirmation via account state
 */
export async function placeOrderAndMonitor(
  client: RestClientInterface,
  symbol: string,
  side: OrderSide,
  amount: number,
  clientOrderId: string,
  exchange: string,
  accountStateManager: AccountStateManager
): Promise<OrderInfo> {
  // Place the order
  const order = await client.createOrder(symbol, 'MARKET', side, amount, undefined, false, clientOrderId)
  
  // Convert to our OrderInfo format
  const orderInfo: OrderInfo = {
    id: order.id,
    clientOrderId,
    symbol: order.symbol,
    orderSide: side,
    positionSide: side === 'BUY' ? 'LONG' : 'SHORT',
    type: 'MARKET',
    price: order.price || 0,
    averagePrice: order.average || 0,
    quantity: order.amount,
    status: order.status as OrderStatus,
    timestamp: order.timestamp,
    date: new Date(order.timestamp)
  }

  // Monitor for order confirmation via account state
  await monitorOrderConfirmation(orderInfo, exchange, accountStateManager)

  return orderInfo
}

/**
 * Monitor order confirmation via account state manager
 */
export async function monitorOrderConfirmation(
  orderInfo: OrderInfo, 
  exchange: string, 
  accountStateManager: AccountStateManager,
  timeoutMs: number = 10000
): Promise<void> {
  const startTime = Date.now()
  
  while (Date.now() - startTime < timeoutMs) {
    // Check if order is in account state
    const accountOrder = accountStateManager.getOrder(exchange, orderInfo.id)
    
    if (accountOrder && accountOrder.status === 'FILLED') {
      // Update order info with confirmed data
      orderInfo.status = 'FILLED'
      orderInfo.averagePrice = accountOrder.averagePrice
      orderInfo.quantity = accountOrder.quantity
      logger.debug(`Order ${orderInfo.id} confirmed as FILLED`)
      return
    }
    
    // Wait before next check
    await delay(100)
  }
  
  // If we reach here, order confirmation timed out
  logger.warn(`Order ${orderInfo.id} confirmation timed out`)
  throw new Error(`Order confirmation timeout for ${orderInfo.id}`)
}

/**
 * Calculate slippage for an order with proper direction awareness
 */
export function calculateSlippage(orderInfo: OrderInfo, side: OrderSide): number {
  if (orderInfo.price === 0 || orderInfo.averagePrice === 0) return 0
  
  let slippagePercent: number
  
  if (side === 'BUY') {
    // For BUY orders: buying into the ask side
    // Positive slippage means we paid more than expected (bad)
    slippagePercent = (orderInfo.averagePrice - orderInfo.price) / orderInfo.price
  } else {
    // For SELL orders: selling into the bid side
    // Positive slippage means we paid more than expected (bad)
    slippagePercent = (orderInfo.price - orderInfo.averagePrice) / orderInfo.averagePrice
  }
  
  const slippageValue = orderInfo.averagePrice * orderInfo.quantity * slippagePercent
  
  return slippageValue
}

/**
 * Calculate fees for an order
 */
export function calculateFees(orderInfo: OrderInfo, exchangeId: string, feeRate: number): number {
  return orderInfo.averagePrice * orderInfo.quantity * feeRate
}

/**
 * Utility delay function
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
} 
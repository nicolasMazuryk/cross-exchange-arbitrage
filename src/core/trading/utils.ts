import { RestClientInterface } from '../../adapters/rest/types'
import { AccountStateManager } from '../state/accountStateManager'
import { OrderSide } from '../../types/exchange'
import { OrderInfo } from '../../types/account'
import { Logger } from '../../utils/logger'
import config from '../../utils/config'

const logger = new Logger('trading-utils')

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
  try {
    // Place the order
    const order = await client.createOrder(symbol, 'MARKET', side, amount, price, isReduceOnly, clientOrderId)

    const orderInfo = await monitorOrderConfirmation(order.id, exchange, accountStateManager)

    orderInfo.expectedPrice = price
    orderInfo.exchange = exchange

    return orderInfo
  } catch (error) {
    logger.error({
      msg: 'Failed to place and monitor order',
      function: 'placeOrderAndMonitor',
      exchange,
      symbol,
      side,
      amount,
      price,
      isReduceOnly,
      clientOrderId,
      error,
    })
    throw error
  }
}

/**
 * Monitor order confirmation via account state manager and populate complete OrderInfo
 */
export async function monitorOrderConfirmation(
  orderId: string,
  exchange: string,
  accountStateManager: AccountStateManager
): Promise<OrderInfo> {
  const startTime = Date.now()

  try {
    while (Date.now() - startTime < config.trading.orderConfirmationTimeoutMs) {
      // Check if order is in account state
      const accountOrder = accountStateManager.getOrder(exchange, orderId)

      if (accountOrder && accountOrder.status === 'FILLED') {
        logger.debug({ msg: 'Order confirmed as FILLED', function: 'monitorOrderConfirmation', orderId, exchange })
        return accountOrder
      }

      // Wait before next check
      await delay(100)
    }

    // If we reach here, order confirmation timed out
    const timeoutError = new Error(`Order confirmation timeout for ${orderId}`)
    logger.error({
      msg: 'Order confirmation timed out',
      function: 'monitorOrderConfirmation',
      orderId,
      exchange,
      timeoutMs: config.trading.orderConfirmationTimeoutMs,
      error: timeoutError,
    })
    throw timeoutError
  } catch (error) {
    logger.error({
      msg: 'Error monitoring order confirmation',
      function: 'monitorOrderConfirmation',
      orderId,
      exchange,
      error,
    })
    throw error
  }
}

/**
 * Calculate slippage for an order with proper direction awareness
 */
export function calculateSlippage(
  orderInfo: OrderInfo,
  side: OrderSide
): { slippageUsd: number; slippagePercent: number } {
  if (!orderInfo.expectedPrice || orderInfo.expectedPrice === 0 || orderInfo.averagePrice === 0)
    return { slippageUsd: 0, slippagePercent: 0 }

  let slippagePercent: number = 0

  if (side === 'BUY') {
    // For BUY orders: buying into the ask side
    // Positive slippage means we paid more than expected (bad)
    slippagePercent = ((orderInfo.averagePrice - orderInfo.expectedPrice) / orderInfo.expectedPrice) * 100
  } else if (side === 'SELL') {
    // For SELL orders: selling into the bid side
    // Positive slippage means we paid more than expected (bad)
    slippagePercent = ((orderInfo.expectedPrice - orderInfo.averagePrice) / orderInfo.averagePrice) * 100
  } else {
    logger.error({
      msg: 'Invalid side for slippage calculation',
      function: 'calculateSlippage',
      side,
      orderInfo,
    })
    throw new Error(`Invalid side for slippage calculation: ${side}`)
  }

  const slippageUsd = orderInfo.averagePrice * orderInfo.quantity * (slippagePercent / 100)

  return { slippageUsd, slippagePercent }
}

/**
 * Calculate fees for an order
 */
export function calculateFees(orderInfo: OrderInfo, feePercent: number): { feesUsd: number; feesPercent: number } {
  const feesUsd = orderInfo.averagePrice * orderInfo.quantity * (feePercent / 100)
  return { feesUsd, feesPercent: feePercent }
}

/**
 * Utility delay function
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

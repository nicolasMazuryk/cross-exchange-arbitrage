import { EventEmitter } from 'events'
import { BalanceInfo, PositionInfo, OrderInfo, AccountState, AccountStateUpdate } from '../../types/account'
import { OrderStatus, PositionSide } from '../../types/exchange'
import logger from '../../utils/logger'
import config from '../../utils/config'

interface ExchangeState {
  balances: BalanceInfo[]
  positions: PositionInfo[]
  orders: OrderInfo[]
  lastUpdate: {
    balances: number
    positions: number
    orders: number
  }
}

export class AccountStateManager extends EventEmitter {
  private exchangeStates: Map<string, ExchangeState> = new Map()

  constructor() {
    super()
    logger.info('AccountStateManager initialized')
  }

  // Getter methods
  getBalances(exchange: string): BalanceInfo[] {
    const state = this.exchangeStates.get(exchange)
    return state?.balances || []
  }

  getPositions(exchange: string): PositionInfo[] {
    const state = this.exchangeStates.get(exchange)
    return state?.positions || []
  }

  getOrders(exchange: string): OrderInfo[] {
    const state = this.exchangeStates.get(exchange)
    return state?.orders || []
  }

  getAccountState(exchange: string): AccountState {
    const state = this.exchangeStates.get(exchange)
    if (!state) {
      return { balances: [], positions: [], orders: [] }
    }
    return {
      balances: state.balances,
      positions: state.positions,
      orders: state.orders
    }
  }

  // Update methods
  updateBalances(exchange: string, balances: BalanceInfo[]): void {
    let state = this.exchangeStates.get(exchange)
    if (!state) {
      state = this.createInitialState()
      this.exchangeStates.set(exchange, state)
    }

    for (const balance of [ ...balances ]) {
      const existingIndex = state.balances.findIndex(b => b.asset === balance.asset)
      if (existingIndex >= 0) {
        state.balances[existingIndex] = balance
      } else {
        state.balances.push(balance)
      }
    }

    state.lastUpdate.balances = Date.now()

    logger.debug(`[${exchange}] Updated balances: ${balances.length} assets`)
    this.emit('stateUpdate', { exchange, type: 'balance', data: state.balances, timestamp: Date.now() })
  }

  updatePositions(exchange: string, positions: PositionInfo[]): void {
    let state = this.exchangeStates.get(exchange)
    if (!state) {
      state = this.createInitialState()
      this.exchangeStates.set(exchange, state)
    }

    // Handle position updates
    for (const position of [ ...positions ]) {
      const existingIndex = state.positions.findIndex(p => p.id === position.id)
      
      if (position.size > 0) {
        // Position has size, add or update
        if (existingIndex >= 0) {
          state.positions[existingIndex] = position
        } else {
          state.positions.push(position)
        }
      } else {
        // Position size is 0, remove it (closed position)
        if (existingIndex >= 0) {
          state.positions.splice(existingIndex, 1)
        }
      }
    }

    state.lastUpdate.positions = Date.now()

    logger.debug(`[${exchange}] Updated positions: ${state.positions.length} positions`)
    this.emit('stateUpdate', { exchange, type: 'position', data: state.positions, timestamp: Date.now() })
  }

  updateOrders(exchange: string, orders: OrderInfo[]): void {
    let state = this.exchangeStates.get(exchange)
    if (!state) {
      state = this.createInitialState()
      this.exchangeStates.set(exchange, state)
    }

    for (const order of [ ...orders ]) {
      const existingIndex = state.orders.findIndex(o => o.id === order.id)

      // if (this.isTerminalOrderStatus(order.status)) {
      //   if (existingIndex >= 0) {
      //     state.orders.splice(existingIndex, 1)
      //   }
      // } else {
        if (existingIndex >= 0) {
          state.orders[existingIndex] = order
        } else {
          state.orders.push(order)
        }
      // }
    }

    state.lastUpdate.orders = Date.now()

    logger.debug(`[${exchange}] Updated orders: ${state.orders.length} orders`)
    this.emit('stateUpdate', { exchange, type: 'order', data: state.orders, timestamp: Date.now() })
  }

  private isTerminalOrderStatus(status: OrderStatus): boolean {
    return status === 'FILLED' || status === 'CANCELED' || status === 'FAILED'
  }

  getLastUpdateTime(exchange: string, type: 'balances' | 'positions' | 'orders'): number {
    const state = this.exchangeStates.get(exchange)
    if (!state) return 0

    switch (type) {
      case 'balances':
        return state.lastUpdate.balances
      case 'positions':
        return state.lastUpdate.positions
      case 'orders':
        return state.lastUpdate.orders
      default:
        return 0
    }
  }

  isExchangeStateFresh(exchange: string): boolean {
    const state = this.exchangeStates.get(exchange)
    if (!state) return false

    const now = Date.now()
    return (
      now - state.lastUpdate.balances < config.accountSync.maxStateAgeMs &&
      now - state.lastUpdate.positions < config.accountSync.maxStateAgeMs &&
      now - state.lastUpdate.orders < config.accountSync.maxStateAgeMs
    )
  }

  getTotalBalance(exchange: string, asset: string): number {
    const balances = this.getBalances(exchange)
    const balance = balances.find(b => b.asset === asset)
    return balance?.total || 0
  }

  getAvailableBalance(exchange: string, asset: string): number {
    const balances = this.getBalances(exchange)
    const balance = balances.find(b => b.asset === asset)
    return balance?.available || 0
  }

  getPosition(exchange: string, symbol: string, side: PositionSide): PositionInfo | null {
    const positions = this.getPositions(exchange)
    return positions.find(p => p.symbol === symbol && p.side === side) || null
  }

  getOrder(exchange: string, orderId: string): OrderInfo | null {
    const orders = this.getOrders(exchange)
    return orders.find(o => o.id === orderId) || null
  }

  getOrderByClientOrderId(exchange: string, clientOrderId: string): OrderInfo | null {
    const orders = this.getOrders(exchange)
    return orders.find(o => o.clientOrderId === clientOrderId) || null
  }

  getActiveOrders(exchange: string): OrderInfo[] {
    const orders = this.getOrders(exchange)
    return orders.filter(o => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED')
  }

  // Handle account state updates from WebSocket streams
  handleAccountStateUpdate(update: AccountStateUpdate): void {
    switch (update.type) {
      case 'balance':
        this.updateBalances(update.exchange, update.data as BalanceInfo[])
        break
      case 'position':
        this.updatePositions(update.exchange, update.data as PositionInfo[])
        break
      case 'order':
        this.updateOrders(update.exchange, update.data as OrderInfo[])
        break
    }
  }

  // Clear state for an exchange (useful for testing or reconnection)
  clearExchangeState(exchange: string): void {
    this.exchangeStates.delete(exchange)
    logger.info(`[${exchange}] Cleared account state`)
  }

  // Get summary statistics
  getStateSummary(): Record<string, { balances: number, positions: number, orders: number }> {
    const summary: Record<string, { balances: number, positions: number, orders: number }> = {}
    
    for (const [exchange, state] of this.exchangeStates.entries()) {
      summary[exchange] = {
        balances: state.balances.length,
        positions: state.positions.length,
        orders: state.orders.length
      }
    }

    return summary
  }

  private createInitialState(): ExchangeState {
    return {
      balances: [],
      positions: [],
      orders: [],
      lastUpdate: {
        balances: 0,
        positions: 0,
        orders: 0
      }
    }
  }
} 
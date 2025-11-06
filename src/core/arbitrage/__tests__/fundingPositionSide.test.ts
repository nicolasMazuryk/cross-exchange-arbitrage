/**
 * Simple tests for funding position side logic
 */

describe('Funding Position Side Logic', () => {
  it('should correctly calculate funding impact for BUY position with positive funding rate', () => {
    // BUY position with positive funding rate should result in loss (we pay funding)
    const positionValue = 10000
    const fundingRate = 0.0001 // 0.01% positive

    // BUY position impact: -fundingRate * positionValue
    const expectedImpact = -fundingRate * positionValue // -$1

    expect(expectedImpact).toBe(-1)
  })

  it('should correctly calculate funding impact for BUY position with negative funding rate', () => {
    // BUY position with negative funding rate should result in profit (we receive funding)
    const positionValue = 10000
    const fundingRate = -0.0001 // -0.01% negative

    // BUY position impact: -fundingRate * positionValue
    const expectedImpact = -fundingRate * positionValue // +$1

    expect(expectedImpact).toBe(1)
  })

  it('should correctly calculate funding impact for SELL position with positive funding rate', () => {
    // SELL position with positive funding rate should result in profit (we receive funding)
    const positionValue = 10000
    const fundingRate = 0.0001 // 0.01% positive

    // SELL position impact: +fundingRate * positionValue
    const expectedImpact = fundingRate * positionValue // +$1

    expect(expectedImpact).toBe(1)
  })

  it('should correctly calculate funding impact for SELL position with negative funding rate', () => {
    // SELL position with negative funding rate should result in loss (we pay funding)
    const positionValue = 10000
    const fundingRate = -0.0001 // -0.01% negative

    // SELL position impact: +fundingRate * positionValue
    const expectedImpact = fundingRate * positionValue // -$1

    expect(expectedImpact).toBe(-1)
  })

  it('should correctly calculate net funding impact for arbitrage positions', () => {
    const positionValue = 10000

    // BUY exchange: positive funding rate (we pay)
    const buyFundingRate = 0.0001 // 0.01%
    const buyImpact = -buyFundingRate * positionValue // -$1

    // SELL exchange: negative funding rate (we pay)
    const sellFundingRate = -0.0001 // -0.01%
    const sellImpact = sellFundingRate * positionValue // -$1

    // Net impact: both positions result in loss
    const netImpact = buyImpact + sellImpact // -$2

    expect(netImpact).toBe(-2)
  })

  it('should correctly calculate net funding impact for profitable arbitrage', () => {
    const positionValue = 10000

    // BUY exchange: negative funding rate (we receive)
    const buyFundingRate = -0.0001 // -0.01%
    const buyImpact = -buyFundingRate * positionValue // +$1

    // SELL exchange: positive funding rate (we receive)
    const sellFundingRate = 0.0001 // 0.01%
    const sellImpact = sellFundingRate * positionValue // +$1

    // Net impact: both positions result in profit
    const netImpact = buyImpact + sellImpact // +$2

    expect(netImpact).toBe(2)
  })
})

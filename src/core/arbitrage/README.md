# Arbitrage Engine - Temporal Persistence Validation

## Overview

The Temporal Persistence Validation feature enhances the arbitrage engine to filter out transient "flicker" spreads that do not reflect true market conditions. This prevents false arbitrage signals caused by one-time order book spikes (<50ms) that disappear before execution.

## Problem Statement

The system was suffering from false arbitrage signals caused by:
- One-time order book spikes that disappear before execution
- Transient market noise that doesn't represent real arbitrage opportunities
- Losses due to executing on non-persistent spreads
- **Flickery orderbooks** where one exchange updates frequently while another remains stable

## Solution

### Temporal Persistence Validation

The arbitrage engine now requires that any arbitrage opportunity persists across multiple snapshots or a minimum time window before it can be executed. This filters out "flicker" spreads that do not reflect true market conditions.

### Implementation Details

#### 1. Data Collection
- Maintains a **rolling buffer** of arbitrage candidates per exchange and symbol pair
- For each candidate, stores:
  - `firstDetectedAt` timestamp
  - `lastDetectedAt` timestamp
  - `buyExchangeConsecutiveSnapshots` count
  - `sellExchangeConsecutiveSnapshots` count (tracked separately)
  - Spread and profit information

#### 2. Candidate Tracking
- When a potential arbitrage opportunity is detected:
  - Records `firstDetectedAt` timestamp
  - Stores candidate in a map keyed by `(pair, buyExchange, sellExchange)`
  - **Tracks snapshots separately for each exchange** to handle flickery orderbooks
- On subsequent updates:
  - If spread stays above threshold: Updates `lastDetectedAt` and increments snapshots for the updating exchange
  - If spread drops below threshold: Resets/removes candidate

#### 3. Persistence Check
Before triggering trade execution, the system computes:
```typescript
persistenceDuration = lastDetectedAt - firstDetectedAt
```

And requires either:
- `persistenceDuration >= minPersistenceMs` (e.g., 500ms)
- **OR** both exchanges have `>= minConsecutiveSnapshots` (e.g., 3–5 consecutive updates each)

#### 4. Execution Price Validation
- Uses **volume-weighted average execution prices** (`entryBuySimulation.avgNormalizedExecutionPrice` and `entrySellSimulation.avgNormalizedExecutionPrice`)
- Ensures price comparisons reflect actual execution conditions rather than just top-of-book prices
- More accurate spread stability validation

#### 5. Configuration Parameters

```yaml
arbitrage:
  minPersistenceMs: 500             # minimum time window (500ms)
  minConsecutiveSnapshots: 3        # minimum consecutive snapshots per exchange
  candidateCleanupMs: 5000          # cleanup stale candidates after 5 seconds
```

### Key Features

#### Exchange-Specific Snapshot Tracking
- **Separate tracking** for each exchange's consecutive snapshots
- Handles cases where one exchange updates frequently while another remains stable
- Prevents false positives from flickery orderbooks
- Only validates when both exchanges meet minimum snapshot requirements

#### Execution Price Validation
- Compares **volume-weighted average execution prices** instead of top-of-book prices
- Accounts for slippage and depth when validating price stability
- More accurate representation of actual trading conditions
- Reduces false signals from thin orderbook levels

#### Spread Stability Validation
- Monitors spread changes between snapshots using execution prices
- Resets candidates if spread decreases by >20% or execution price changes by >1%
- Ensures only stable opportunities proceed

#### Memory Management
- Automatic cleanup of stale candidates after configurable timeout
- Prevents memory growth from abandoned candidates
- Logs cleanup activities for monitoring

#### Logging and Monitoring
- Detailed logging of candidate lifecycle
- Tracks persistence duration and snapshot counts for each exchange
- Logs opportunities that fail persistence for analytics

### Integration Points

- **ArbitrageEngine**: Main implementation in `src/core/arbitrage/arbitrageEngine.ts`
- **Configuration**: Parameters in `config/{env}.yaml`
- **Event System**: Wraps existing opportunity detection logic
- **Exchange-Specific**: Candidate tracking is exchange- and pair-specific to avoid cross-contamination

### Safety Features

#### Timestamp Consistency
- Uses exchange-provided or system clock timestamps
- Ensures accurate persistence duration calculation

#### Stale Candidate Cleanup
- Automatic cleanup after configurable timeout (default: 5 seconds)
- Prevents memory leaks and stale data

#### Execution Price Change Detection
- Monitors significant execution price changes
- Resets candidates when market conditions change substantially
- Uses volume-weighted averages for more accurate comparisons

### Benefits

1. **Reduced False Positives**: Filters out transient noise and flicker spreads
2. **Improved Profitability**: Only executes on real, actionable market imbalances
3. **Better Risk Management**: Reduces losses from executing on non-persistent opportunities
4. **Enhanced Monitoring**: Detailed logging for analytics and optimization
5. **Flickery Orderbook Handling**: Separate tracking prevents false signals from unstable exchanges
6. **Accurate Price Validation**: Execution price comparison reflects real trading conditions

### Testing

The feature includes comprehensive tests in `src/core/arbitrage/arbitrageEngine.test.ts`:

- **New Candidate Validation**: Ensures new candidates don't immediately trigger execution
- **Persistence Requirements**: Verifies opportunities only execute after meeting persistence criteria
- **Memory Management**: Tests automatic cleanup of stale candidates

### Example Log Output

```
New arbitrage candidate detected: BTCUSDT:binance:bybit, spread: 0.200%, profit: 0.150%
Candidate BTCUSDT:binance:bybit still building persistence: duration=150ms, buySnapshots=2, sellSnapshots=1
Arbitrage opportunity validated: BTCUSDT:binance:bybit, duration: 200ms, buySnapshots: 3, sellSnapshots: 3, spread: 0.200%, profit: 0.150%
Cleaned up stale candidate: BTCUSDT:binance:bybit
```

This enhancement significantly reduces false positives and ensures the arbitrage engine only executes on real, actionable market imbalances instead of transient noise, with improved handling of flickery orderbooks and more accurate price validation. 
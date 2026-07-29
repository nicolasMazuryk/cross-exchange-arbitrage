# Orderbook Market-Data WS Connectivity: Staleness Detection, False Positives, and Threshold Calibration

## 3. "No data" ≠ "bad data" — defeating the false positive

**The problem, precisely:** *no update is itself valid data.* A thin book can legitimately not change for tens of seconds. Silence has two causes — quiet market (valid) and dead/desynced feed (invalid) — and a silence timer **cannot tell them apart**, because measuring silence is exactly the thing that is ambiguous.

**What replaces it (in rough priority):**

4. **Independent fast channel + trade-feed cross-check.** Run BBO/bookTicker alongside full depth. If BBO's top is moving but your depth top is not, the depth feed is stale even though "messages are arriving." When both are quiet, they agree — no false alarm. The trade-through check (a print inside/through your spread) fires even mid-silence.


### Structural-class (detect "feed is lying" — these are veto gates)

8. **Shape / depth-anomaly (soft corroboration).**
   Sudden level-count collapse, top-of-book size → 0, or spread blowing out by orders of magnitude vs rolling baseline. Used to **corroborate, not to kill** outright (it can be a real but rare market event).

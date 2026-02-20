# Weighted Decision Framework – Project Choice A/B/C

You declared the priority order:
1. Speed (already satisfied — tie-breaker only)  
2. Reliability (lower risk = higher score)  
3. Cost (lower cost = higher score)

## Step 1 – Criteria & Weights
Because speed has already been achieved, we fold it into a simple pass/fail Tie. The **active** weights sum to 100 %:
- Reliability (absence of risk): **70 %**
- Cost:                        **30 %**

These two weights mirror the stronger importance of reliability over cost.

## Step 2 – Normalised Raw Scores
Scale everything 0 → 1, where **1 = best**, **0 = worst** for the direction we desire:

| Option | Cost label | Cost value |
|--------|------------|------------|
| A | Low   → 1.0 |
| B | Medium → 0.5 |
| C | High  → 0.0 |

| Option | Risk label | Reliability (inv. risk) |
|--------|------------|-------------------------|
| A | High  → 0.0 |
| B | Medium → 0.5 |
| C | Low   → 1.0 |

## Step 3 – Weighted Score
(Score × Weight) and sum:

For **Option A (low cost / high risk)**
- Reliability: 0.0 × 0.70 = 0.00
- Cost:        1.0 × 0.30 = 0.30
- **Total A = 0.30**

For **Option B (medium / medium)**
- Reliability: 0.5 × 0.70 = 0.35
- Cost:        0.5 × 0.30 = 0.15
- **Total B = 0.50**

For **Option C (high cost / low risk)**
- Reliability: 1.0 × 0.70 = 0.70
- Cost:        0.0 × 0.30 = 0.00
- **Total C = 0.70**

## Step 4 – Tie-Breaker Check
All three satisfy the "speed" gate (already delivered), so no down-grade occurs.

## Recommendation
Choose **Option C** (high cost / low risk).  Its weighted score of 0.70 is the highest under the stated priority order.